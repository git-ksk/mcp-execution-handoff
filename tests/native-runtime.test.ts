import assert from "node:assert/strict";
import test from "node:test";
import { TakeoverBroker, type TakeoverBrowserAdapter } from "../src/browser-takeover/broker.js";
import {
  NativeTakeoverRuntimeError,
  parseNativeTakeoverClientEndpoint,
  type NativeTakeoverClientBootstrap,
  type NativeTakeoverClientEndpoint,
  type NativeTakeoverRuntimeBinding,
  type NativeTakeoverRuntimeProvider
} from "../src/browser-takeover/native-runtime.js";

const PRINCIPAL = "native-principal";
const CLIENT_A = "native-client-binding-aaaaaaaa";
const CLIENT_B = "native-client-binding-bbbbbbbb";

const browser: TakeoverBrowserAdapter = {
  async captureHumanTakeoverFrame() {
    return { data: Buffer.from("x").toString("base64"), width: 1, height: 1, hostname: "example" };
  },
  async tapHumanTakeover() {},
  async scrollHumanTakeover() {},
  async insertHumanTakeoverText() {},
  async pressHumanTakeoverKey() {}
};

class FakeNativeRuntime implements NativeTakeoverRuntimeProvider {
  readonly starts: Array<{ binding: NativeTakeoverRuntimeBinding; endpoint: NativeTakeoverClientEndpoint }> = [];
  readonly revoked: string[] = [];
  private active = new Map<string, number>();

  async begin(
    binding: NativeTakeoverRuntimeBinding,
    endpoint: NativeTakeoverClientEndpoint
  ): Promise<NativeTakeoverClientBootstrap> {
    const generation = this.active.get(binding.takeoverSessionId);
    if (generation === binding.clientGeneration) {
      throw new NativeTakeoverRuntimeError(
        "NATIVE_BOOTSTRAP_ALREADY_ISSUED",
        "already issued"
      );
    }
    if (generation !== undefined) await this.revoke(binding.takeoverSessionId);
    this.active.set(binding.takeoverSessionId, binding.clientGeneration);
    this.starts.push({ binding: { ...binding }, endpoint: { ...endpoint } });
    return {
      rootKeyBase64Url: Buffer.alloc(32, binding.clientGeneration).toString("base64url"),
      sessionHashHex: binding.clientGeneration.toString(16).padStart(16, "0"),
      epoch: binding.epoch,
      network: {
        host: "192.0.2.10",
        videoPort: endpoint.videoPort,
        inputPort: 45_556,
        videoFeedbackPort: 45_558,
        inputFeedbackPort: endpoint.inputFeedbackPort
      }
    };
  }

  async revoke(takeoverSessionId: string): Promise<void> {
    this.revoked.push(takeoverSessionId);
    this.active.delete(takeoverSessionId);
  }

  async revokeForIntervention(interventionId: string): Promise<void> {
    for (const start of this.starts) {
      if (start.binding.interventionId === interventionId) await this.revoke(start.binding.takeoverSessionId);
    }
  }
}

function createFixture(targetProcessId?: number) {
  const native = new FakeNativeRuntime();
  const broker = new TakeoverBroker(browser, {
    enabled: true,
    publicBaseUrl: "https://takeover.example",
    ttlMs: 60_000,
    reconnectIdleMs: 250
  }, native);
  const locator = broker.createNativeLink(
    { id: "native-intervention", epoch: 9 },
    PRINCIPAL,
    targetProcessId === undefined ? undefined : { processId: targetProcessId }
  );
  assert.ok(locator);
  const sessionId = new URL(locator).pathname.split("/").at(-1);
  assert.ok(sessionId);
  return { broker, native, sessionId };
}

function nativeRequestBody(host = "192.0.2.20") {
  return JSON.stringify({ clientHost: host, videoPort: 46_000, inputFeedbackPort: 46_001 });
}

async function claim(broker: TakeoverBroker, sessionId: string, client = CLIENT_A) {
  return broker.handle(new Request(`https://takeover.example/takeover/api/claim/${sessionId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-takeover-native-client": "1",
      "x-takeover-client": client
    },
    body: nativeRequestBody()
  }), PRINCIPAL);
}


test("native runtime binding keeps an optional host target process private and generation-bound", async () => {
  const { broker, native, sessionId } = createFixture(31337);
  const response = await claim(broker, sessionId);
  assert.equal(response.status, 200);
  assert.equal(native.starts[0]!.binding.targetProcessId, 31337);
});

test("native endpoint accepts only bounded IP-literal UDP endpoints", () => {
  assert.deepEqual(parseNativeTakeoverClientEndpoint({
    clientHost: "192.0.2.1",
    videoPort: 45_555,
    inputFeedbackPort: 45_559
  }), {
    clientHost: "192.0.2.1",
    videoPort: 45_555,
    inputFeedbackPort: 45_559
  });
  assert.throws(() => parseNativeTakeoverClientEndpoint({
    clientHost: "example.com",
    videoPort: 45_555,
    inputFeedbackPort: 45_559
  }), NativeTakeoverRuntimeError);
  assert.throws(() => parseNativeTakeoverClientEndpoint({
    clientHost: "192.0.2.1",
    videoPort: 45_555,
    inputFeedbackPort: 45_555
  }), NativeTakeoverRuntimeError);
});

test("Native-only sessions cannot be claimed or driven through the legacy Web frame/input surface", async () => {
  const { broker, sessionId } = createFixture();
  const bootstrap = await broker.handle(new Request(`https://takeover.example/takeover/api/bootstrap/${sessionId}`, {
    headers: {
      "sec-fetch-site": "same-origin",
      "x-takeover-client": CLIENT_A
    }
  }), PRINCIPAL);
  assert.equal(bootstrap.status, 404);

  const claimed = await claim(broker, sessionId);
  assert.equal(claimed.status, 200);
  const grant = await claimed.json() as { capability: string };

  const frame = await broker.handle(new Request(`https://takeover.example/takeover/api/frame/${sessionId}`, {
    headers: {
      "x-takeover-client": CLIENT_A,
      "x-mcp-takeover-capability": grant.capability
    }
  }), PRINCIPAL);
  assert.equal(frame.status, 404);

  const input = await broker.handle(new Request(`https://takeover.example/takeover/api/input/${sessionId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-takeover-client": CLIENT_A,
      "x-mcp-takeover-capability": grant.capability,
      "x-takeover-native-client": "1"
    },
    body: JSON.stringify({ kind: "tap", x: 1, y: 1 })
  }), PRINCIPAL);
  assert.equal(input.status, 404);
});

test("native claim binds one-shot transport bootstrap to broker epoch and generation", async () => {
  const { broker, native, sessionId } = createFixture();
  const response = await claim(broker, sessionId);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  const body = await response.json() as {
    capability: string;
    reconnectHandle: string;
    clientGeneration: number;
    native: NativeTakeoverClientBootstrap;
  };
  assert.equal(body.clientGeneration, 1);
  assert.equal(Buffer.from(body.native.rootKeyBase64Url, "base64url").length, 32);
  assert.equal(body.native.sessionHashHex, "0000000000000001");
  assert.equal(body.native.epoch, 9);
  assert.deepEqual(body.native.network, {
    host: "192.0.2.10",
    videoPort: 46_000,
    inputPort: 45_556,
    videoFeedbackPort: 45_558,
    inputFeedbackPort: 46_001
  });
  assert.equal(native.starts.length, 1);
  assert.equal(native.starts[0]!.binding.interventionId, "native-intervention");
  assert.equal(native.starts[0]!.binding.epoch, 9);
  assert.equal(native.starts[0]!.binding.principalBinding, PRINCIPAL);
  assert.equal(native.starts[0]!.binding.clientGeneration, 1);

  const replay = await claim(broker, sessionId);
  assert.equal(replay.status, 409);
  assert.deepEqual(await replay.json(), { error: "native_bootstrap_already_issued" });
});

test("native reconnect rotates broker generation and transport bootstrap together", async () => {
  const { broker, native, sessionId } = createFixture();
  const firstResponse = await claim(broker, sessionId, CLIENT_A);
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json() as {
    capability: string;
    reconnectHandle: string;
    clientGeneration: number;
    native: NativeTakeoverClientBootstrap;
  };

  await new Promise((resolve) => setTimeout(resolve, 300));
  const secondResponse = await broker.handle(new Request(`https://takeover.example/takeover/api/reconnect/${sessionId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-takeover-native-client": "1",
      "x-takeover-client": CLIENT_B,
      "x-mcp-takeover-reconnect": first.reconnectHandle
    },
    body: nativeRequestBody("192.0.2.21")
  }), PRINCIPAL);
  assert.equal(secondResponse.status, 200);
  const second = await secondResponse.json() as {
    capability: string;
    reconnectHandle: string;
    clientGeneration: number;
    native: NativeTakeoverClientBootstrap;
  };
  assert.equal(second.clientGeneration, 2);
  assert.equal(second.native.epoch, 9);
  assert.notEqual(second.capability, first.capability);
  assert.notEqual(second.reconnectHandle, first.reconnectHandle);
  assert.notEqual(second.native.rootKeyBase64Url, first.native.rootKeyBase64Url);
  assert.equal(native.starts.length, 2);
  assert.equal(native.starts[1]!.binding.clientGeneration, 2);
  assert.equal(native.starts[1]!.endpoint.clientHost, "192.0.2.21");
  assert.ok(native.revoked.includes(sessionId));

  const staleDone = await broker.handle(new Request(`https://takeover.example/takeover/api/done/${sessionId}`, {
    method: "POST",
    headers: {
      "x-takeover-native-client": "1",
      "x-takeover-client": CLIENT_A,
      "x-mcp-takeover-capability": first.capability
    }
  }), PRINCIPAL);
  assert.equal(staleDone.status, 404);
});

test("native Done and Cancel revoke transport and make the generation unusable", async () => {
  for (const operation of ["done", "cancel"] as const) {
    const { broker, native, sessionId } = createFixture();
    const response = await claim(broker, sessionId);
    const grant = await response.json() as { capability: string };
    const closed = await broker.handle(new Request(`https://takeover.example/takeover/api/${operation}/${sessionId}`, {
      method: "POST",
      headers: {
        "x-takeover-native-client": "1",
        "x-takeover-client": CLIENT_A,
        "x-mcp-takeover-capability": grant.capability
      }
    }), PRINCIPAL);
    assert.equal(closed.status, 200);
    assert.ok(native.revoked.includes(sessionId));

    const stale = await broker.handle(new Request(`https://takeover.example/takeover/api/frame/${sessionId}`, {
      headers: {
        "x-takeover-client": CLIENT_A,
        "x-mcp-takeover-capability": grant.capability
      }
    }), PRINCIPAL);
    assert.equal(stale.status, 404);
  }
});
