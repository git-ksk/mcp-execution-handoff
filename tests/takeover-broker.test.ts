import assert from "node:assert/strict";
import test from "node:test";
import { TakeoverBroker, type TakeoverBrowserAdapter } from "../src/browser-takeover/broker.js";

const PRINCIPAL_A = "principal-a";
const PRINCIPAL_B = "principal-b";
const CLIENT_A = "client-binding-a-1234567890";
const CLIENT_B = "client-binding-b-1234567890";

function fixture() {
  const calls: unknown[] = [];
  const browser: TakeoverBrowserAdapter = {
    async captureHumanTakeoverFrame(interventionId, epoch) {
      calls.push(["frame", interventionId, epoch]);
      return {
        data: Buffer.from("jpeg-bytes").toString("base64"),
        width: 390,
        height: 844,
        hostname: "accounts.google.com"
      };
    },
    async tapHumanTakeover(interventionId, epoch, x, y) {
      calls.push(["tap", interventionId, epoch, x, y]);
    },
    async scrollHumanTakeover(interventionId, epoch, deltaY) {
      calls.push(["scroll", interventionId, epoch, deltaY]);
    },
    async insertHumanTakeoverText(interventionId, epoch, text) {
      calls.push(["text", interventionId, epoch, text]);
    },
    async pressHumanTakeoverKey(interventionId, epoch, key) {
      calls.push(["key", interventionId, epoch, key]);
    }
  };
  const broker = new TakeoverBroker(browser, {
    enabled: true,
    publicBaseUrl: "https://takeover.example",
    ttlMs: 60_000
  });
  const link = broker.createLink({ id: "intervention-a", epoch: 7 }, PRINCIPAL_A);
  assert.ok(link);
  const url = new URL(link);
  const sessionId = url.pathname.split("/").at(-1);
  assert.ok(sessionId);
  return { broker, calls, url, sessionId };
}

async function bootstrap(
  broker: TakeoverBroker,
  sessionId: string,
  principal: string = PRINCIPAL_A,
  clientBinding: string = CLIENT_A
): Promise<string> {
  const response = await broker.handle(new Request(`http://localhost/takeover/api/bootstrap/${sessionId}`, {
    headers: {
      "sec-fetch-site": "same-origin",
      "x-takeover-client": clientBinding
    }
  }), principal);
  assert.equal(response.status, 200);
  const body = await response.json() as { capability?: string };
  assert.ok(body.capability);
  return body.capability;
}

test("takeover link is locator-only and the external client stays nonce-bound and memory-only", async () => {
  const { broker, url, sessionId } = fixture();
  assert.equal(url.search, "");
  assert.equal(url.hash, "");

  const response = await broker.handle(new Request(`http://localhost${url.pathname}`), PRINCIPAL_A);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const csp = response.headers.get("content-security-policy") ?? "";
  assert.match(csp, /frame-ancestors 'none'/);
  const nonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(csp)?.[1];
  assert.ok(nonce);
  assert.doesNotMatch(csp, /script-src 'self'/);

  const html = await response.text();
  assert.doesNotMatch(html, /Takeover [A-Za-z0-9_-]{32,}/);
  assert.match(
    html,
    new RegExp(`<script nonce="${nonce}" src="\\/takeover\\/client\\.js" defer><\\/script>`)
  );
  assert.doesNotMatch(html, /sessionStorage|localStorage/);
  assert.doesNotMatch(html, /Maps human takeover|return to MCP/);
  assert.match(html, /id="keyboard"/);
  assert.doesNotMatch(html, /data-scroll|data-key|id="send"/);

  const scriptResponse = await broker.handle(new Request(`http://localhost/takeover/client.js`), PRINCIPAL_A);
  assert.equal(scriptResponse.status, 200);
  assert.match(scriptResponse.headers.get("cache-control") ?? "", /no-store/);
  assert.match(scriptResponse.headers.get("content-type") ?? "", /^text\/javascript/);
  const script = await scriptResponse.text();
  assert.match(script, /takeover\/api\/bootstrap/);
  assert.match(script, /crypto\.getRandomValues/);
  assert.match(script, /const clientBinding=randomClientBinding\(\)/);
  assert.match(script, /x-takeover-client/);
  assert.match(script, /x-mcp-takeover-capability/);
  assert.match(script, /api\('stream'\)/);
  assert.match(script, /response\.body\.getReader/);
  assert.match(script, /pointerdown/);
  assert.match(script, /pointermove/);
  assert.match(script, /pointerup/);
  assert.match(script, /beforeinput/);
  assert.match(script, /kind:'scroll'/);
  assert.doesNotMatch(script, /querySelectorAll\('\[data-scroll\]'/);
  assert.doesNotMatch(script, /authorization['"]?\s*:/i);
  assert.doesNotMatch(script, /sessionStorage|localStorage/);

  const scriptHead = await broker.handle(new Request(`http://localhost/takeover/client.js`, {
    method: "HEAD"
  }), PRINCIPAL_A);
  assert.equal(scriptHead.status, 200);
  assert.equal(await scriptHead.text(), "");

  const scriptPost = await broker.handle(new Request(`http://localhost/takeover/client.js`, {
    method: "POST"
  }), PRINCIPAL_A);
  assert.equal(scriptPost.status, 405);

  const scriptWithoutPrincipal = await broker.handle(new Request(`http://localhost/takeover/client.js`));
  assert.equal(scriptWithoutPrincipal.status, 404);

  const crossSiteBootstrap = await broker.handle(new Request(`http://localhost/takeover/api/bootstrap/${sessionId}`, {
    headers: {
      "sec-fetch-site": "cross-site",
      "x-takeover-client": CLIENT_A
    }
  }), PRINCIPAL_A);
  assert.equal(crossSiteBootstrap.status, 403);
});

test("push frame stream keeps the capability in headers and emits bounded binary frames", async () => {
  const browser: TakeoverBrowserAdapter = {
    async captureHumanTakeoverFrame() {
      throw new Error("polling fallback should not be used");
    },
    async *streamHumanTakeoverFrames(interventionId, epoch, signal) {
      assert.equal(interventionId, "stream-intervention");
      assert.equal(epoch, 3);
      assert.equal(signal.aborted, false);
      yield {
        data: Buffer.from("frame-one").toString("base64"),
        width: 800,
        height: 600,
        hostname: "accounts.google.com"
      };
      yield {
        data: Buffer.from("frame-two").toString("base64"),
        width: 800,
        height: 600,
        hostname: "accounts.google.com",
        mimeType: "image/png"
      };
    },
    async tapHumanTakeover() {},
    async scrollHumanTakeover() {},
    async insertHumanTakeoverText() {},
    async pressHumanTakeoverKey() {}
  };
  const broker = new TakeoverBroker(browser, { enabled: true, publicBaseUrl: "https://takeover.example", ttlMs: 60_000 });
  const link = broker.createLink({ id: "stream-intervention", epoch: 3 }, PRINCIPAL_A);
  assert.ok(link);
  const sessionId = new URL(link).pathname.split("/").at(-1);
  assert.ok(sessionId);
  const capability = await bootstrap(broker, sessionId);
  const response = await broker.handle(new Request(`http://localhost/takeover/api/stream/${sessionId}`, {
    headers: {
      "x-mcp-takeover-capability": capability,
      "x-takeover-client": CLIENT_A
    }
  }), PRINCIPAL_A);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-takeover-stream"), "1");
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  const bytes = Buffer.from(await response.arrayBuffer());
  const frames: Array<{ meta: Record<string, unknown>; image: string }> = [];
  let offset = 0;
  while (offset < bytes.length) {
    const metaLength = bytes.readUInt32BE(offset);
    const imageLength = bytes.readUInt32BE(offset + 4);
    offset += 8;
    const meta = JSON.parse(bytes.subarray(offset, offset + metaLength).toString("utf8")) as Record<string, unknown>;
    offset += metaLength;
    const image = bytes.subarray(offset, offset + imageLength).toString("utf8");
    offset += imageLength;
    frames.push({ meta, image });
  }
  assert.deepEqual(frames, [
    { meta: { width: 800, height: 600, hostname: "accounts.google.com", mimeType: "image/jpeg" }, image: "frame-one" },
    { meta: { width: 800, height: 600, hostname: "accounts.google.com", mimeType: "image/png" }, image: "frame-two" }
  ]);
});

test("push frame stream falls back cleanly when an adapter does not implement streaming", async () => {
  const { broker, sessionId } = fixture();
  const capability = await bootstrap(broker, sessionId);
  const response = await broker.handle(new Request(`http://localhost/takeover/api/stream/${sessionId}`, {
    headers: {
      "x-mcp-takeover-capability": capability,
      "x-takeover-client": CLIENT_A
    }
  }), PRINCIPAL_A);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "frame_stream_unavailable" });
});

test("adapter may return PNG frames without browser-side conversion", async () => {
  const browser: TakeoverBrowserAdapter = {
    async captureHumanTakeoverFrame() {
      return {
        data: Buffer.from("png-bytes").toString("base64"),
        width: 800,
        height: 600,
        hostname: "Normal Chrome",
        mimeType: "image/png"
      };
    },
    async tapHumanTakeover() {},
    async scrollHumanTakeover() {},
    async insertHumanTakeoverText() {},
    async pressHumanTakeoverKey() {}
  };
  const broker = new TakeoverBroker(browser, { enabled: true, publicBaseUrl: "https://takeover.example", ttlMs: 60_000 });
  const link = broker.createLink({ id: "png-intervention", epoch: 2 }, PRINCIPAL_A);
  assert.ok(link);
  const sessionId = new URL(link).pathname.split("/").at(-1);
  assert.ok(sessionId);
  const capability = await bootstrap(broker, sessionId);
  const response = await broker.handle(new Request(`http://localhost/takeover/api/frame/${sessionId}`, {
    headers: {
      "x-mcp-takeover-capability": capability,
      "x-takeover-client": CLIENT_A
    }
  }), PRINCIPAL_A);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("x-takeover-width"), "800");
  assert.equal(response.headers.get("x-takeover-height"), "600");
});

test("different or missing principal cannot open or bootstrap another takeover", async () => {
  const { broker, url, sessionId } = fixture();
  const wrongPage = await broker.handle(new Request(`http://localhost${url.pathname}`), PRINCIPAL_B);
  assert.equal(wrongPage.status, 404);

  const wrongBootstrap = await broker.handle(new Request(`http://localhost/takeover/api/bootstrap/${sessionId}`, {
    headers: {
      "sec-fetch-site": "same-origin",
      "x-takeover-client": CLIENT_A
    }
  }), PRINCIPAL_B);
  assert.equal(wrongBootstrap.status, 404);

  const missing = await broker.handle(new Request(`http://localhost${url.pathname}`));
  assert.equal(missing.status, 404);
});

test("same principal cannot claim one takeover from two remote clients", async () => {
  const { broker, sessionId } = fixture();
  const capability = await bootstrap(broker, sessionId, PRINCIPAL_A, CLIENT_A);

  const retryBySameClient = await broker.handle(new Request(`http://localhost/takeover/api/bootstrap/${sessionId}`, {
    headers: {
      "sec-fetch-site": "same-origin",
      "x-takeover-client": CLIENT_A
    }
  }), PRINCIPAL_A);
  assert.equal(retryBySameClient.status, 200);
  const retried = await retryBySameClient.json() as { capability?: string };
  assert.equal(retried.capability, capability);

  const secondClient = await broker.handle(new Request(`http://localhost/takeover/api/bootstrap/${sessionId}`, {
    headers: {
      "sec-fetch-site": "same-origin",
      "x-takeover-client": CLIENT_B
    }
  }), PRINCIPAL_A);
  assert.equal(secondClient.status, 404);
});

test("frame and bounded inputs require matching principal, client lease, capability and origin", async () => {
  const { broker, calls, sessionId } = fixture();
  const capability = await bootstrap(broker, sessionId);
  const auth = {
    "x-mcp-takeover-capability": capability,
    "x-takeover-client": CLIENT_A
  };

  const denied = await broker.handle(new Request(`http://localhost/takeover/api/frame/${sessionId}`, {
    headers: { "x-takeover-client": CLIENT_A }
  }), PRINCIPAL_A);
  assert.equal(denied.status, 404);

  const wrongPrincipal = await broker.handle(new Request(`http://localhost/takeover/api/frame/${sessionId}`, { headers: auth }), PRINCIPAL_B);
  assert.equal(wrongPrincipal.status, 404);

  const wrongClient = await broker.handle(new Request(`http://localhost/takeover/api/frame/${sessionId}`, {
    headers: {
      "x-mcp-takeover-capability": capability,
      "x-takeover-client": CLIENT_B
    }
  }), PRINCIPAL_A);
  assert.equal(wrongClient.status, 404);

  const frame = await broker.handle(new Request(`http://localhost/takeover/api/frame/${sessionId}`, { headers: auth }), PRINCIPAL_A);
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get("x-takeover-width"), "390");
  assert.equal(frame.headers.get("x-takeover-height"), "844");
  assert.equal(frame.headers.get("x-takeover-host"), "accounts.google.com");

  const wrongOrigin = await broker.handle(new Request(`http://localhost/takeover/api/input/${sessionId}`, {
    method: "POST",
    headers: { ...auth, origin: "https://evil.example", "content-type": "application/json" },
    body: JSON.stringify({ kind: "tap", x: 10, y: 20 })
  }), PRINCIPAL_A);
  assert.equal(wrongOrigin.status, 403);

  const accepted = await broker.handle(new Request(`http://localhost/takeover/api/input/${sessionId}`, {
    method: "POST",
    headers: { ...auth, origin: "https://takeover.example", "content-type": "application/json" },
    body: JSON.stringify({ kind: "tap", x: 10, y: 20 })
  }), PRINCIPAL_A);
  assert.equal(accepted.status, 200);
  assert.deepEqual(calls.at(-1), ["tap", "intervention-a", 7, 10, 20]);
});

test("dedicated takeover capability coexists with an outer Bearer Authorization header", async () => {
  const { broker, calls, sessionId } = fixture();
  const capability = await bootstrap(broker, sessionId);
  const frame = await broker.handle(new Request(`http://localhost/takeover/api/frame/${sessionId}`, {
    headers: {
      authorization: "Bearer private-hop-service-credential",
      "x-mcp-takeover-capability": capability,
      "x-takeover-client": CLIENT_A
    }
  }), PRINCIPAL_A);
  assert.equal(frame.status, 200);
  assert.deepEqual(calls.at(-1), ["frame", "intervention-a", 7]);
});

test("legacy Authorization Takeover capability remains accepted for compatibility", async () => {
  const { broker, sessionId } = fixture();
  const capability = await bootstrap(broker, sessionId);
  const frame = await broker.handle(new Request(`http://localhost/takeover/api/frame/${sessionId}`, {
    headers: {
      authorization: `Takeover ${capability}`,
      "x-takeover-client": CLIENT_A
    }
  }), PRINCIPAL_A);
  assert.equal(frame.status, 200);
});

test("done revokes remote capability and client lease without approving the MCP action", async () => {
  const { broker, sessionId } = fixture();
  const capability = await bootstrap(broker, sessionId);
  const auth = {
    "x-mcp-takeover-capability": capability,
    "x-takeover-client": CLIENT_A,
    origin: "https://takeover.example"
  };
  const done = await broker.handle(new Request(`http://localhost/takeover/api/done/${sessionId}`, {
    method: "POST",
    headers: auth
  }), PRINCIPAL_A);
  assert.equal(done.status, 200);
  assert.deepEqual(await done.json(), { done: true });

  const stale = await broker.handle(new Request(`http://localhost/takeover/api/frame/${sessionId}`, {
    headers: {
      "x-mcp-takeover-capability": capability,
      "x-takeover-client": CLIENT_A
    }
  }), PRINCIPAL_A);
  assert.equal(stale.status, 404);
});
test("reload or another tab cannot implicitly reclaim an existing lease", async () => {
  const { broker, sessionId } = fixture();
  await bootstrap(broker, sessionId, PRINCIPAL_A, CLIENT_A);
  const reloadWithFreshMemoryBinding = await broker.handle(new Request(`http://localhost/takeover/api/bootstrap/${sessionId}`, {
    headers: { "sec-fetch-site": "same-origin", "x-takeover-client": CLIENT_B }
  }), PRINCIPAL_A);
  assert.equal(reloadWithFreshMemoryBinding.status, 404);
});

test("native client claim requires explicit native header and authenticated principal", async () => {
  const { broker, sessionId } = fixture();
  const denied = await broker.handle(new Request(`http://localhost/takeover/api/claim/${sessionId}`, {
    method: "POST",
    headers: { "x-takeover-client": CLIENT_A }
  }), PRINCIPAL_A);
  assert.equal(denied.status, 403);

  const crossOrigin = await broker.handle(new Request(`http://localhost/takeover/api/claim/${sessionId}`, {
    method: "POST",
    headers: {
      "x-takeover-client": CLIENT_A,
      "x-takeover-native-client": "1",
      origin: "https://evil.example"
    }
  }), PRINCIPAL_A);
  assert.equal(crossOrigin.status, 403);

  const accepted = await broker.handle(new Request(`http://localhost/takeover/api/claim/${sessionId}`, {
    method: "POST",
    headers: {
      "x-takeover-client": CLIENT_A,
      "x-takeover-native-client": "1"
    }
  }), PRINCIPAL_A);
  assert.equal(accepted.status, 200);
  const body = await accepted.json() as {
    capability?: string;
    reconnectHandle?: string;
    clientGeneration?: number;
  };
  assert.match(body.capability ?? "", /^[A-Za-z0-9_-]{32,128}$/);
  assert.match(body.reconnectHandle ?? "", /^[A-Za-z0-9_-]{32,128}$/);
  assert.equal(body.clientGeneration, 1);
});

test("native reconnect fences the prior client generation after the lease becomes idle", async () => {
  const calls: unknown[] = [];
  const browser: TakeoverBrowserAdapter = {
    async captureHumanTakeoverFrame(interventionId, epoch) {
      calls.push(["frame", interventionId, epoch]);
      return {
        data: Buffer.from("jpeg-bytes").toString("base64"),
        width: 390,
        height: 844,
        hostname: "Browser"
      };
    },
    async tapHumanTakeover() {},
    async scrollHumanTakeover() {},
    async insertHumanTakeoverText() {},
    async pressHumanTakeoverKey() {}
  };
  const broker = new TakeoverBroker(browser, {
    enabled: true,
    publicBaseUrl: "https://takeover.example",
    ttlMs: 60_000,
    reconnectIdleMs: 1_000
  });
  const link = broker.createLink({ id: "reconnect-intervention", epoch: 4 }, PRINCIPAL_A);
  assert.ok(link);
  const sessionId = new URL(link).pathname.split("/").at(-1);
  assert.ok(sessionId);

  const initial = await broker.handle(new Request(`http://localhost/takeover/api/claim/${sessionId}`, {
    method: "POST",
    headers: {
      "x-takeover-client": CLIENT_A,
      "x-takeover-native-client": "1"
    }
  }), PRINCIPAL_A);
  assert.equal(initial.status, 200);
  const first = await initial.json() as {
    capability: string;
    reconnectHandle: string;
    clientGeneration: number;
  };

  const stillActive = await broker.handle(new Request(`http://localhost/takeover/api/reconnect/${sessionId}`, {
    method: "POST",
    headers: {
      "x-takeover-client": CLIENT_B,
      "x-takeover-native-client": "1",
      "x-mcp-takeover-reconnect": first.reconnectHandle
    }
  }), PRINCIPAL_A);
  assert.equal(stillActive.status, 409);
  assert.deepEqual(await stillActive.json(), { error: "takeover_client_active" });

  await new Promise((resolve) => setTimeout(resolve, 1_050));
  const recovered = await broker.handle(new Request(`http://localhost/takeover/api/reconnect/${sessionId}`, {
    method: "POST",
    headers: {
      "x-takeover-client": CLIENT_B,
      "x-takeover-native-client": "1",
      "x-mcp-takeover-reconnect": first.reconnectHandle
    }
  }), PRINCIPAL_A);
  assert.equal(recovered.status, 200);
  const second = await recovered.json() as {
    capability: string;
    reconnectHandle: string;
    clientGeneration: number;
  };
  assert.equal(second.clientGeneration, 2);
  assert.notEqual(second.capability, first.capability);
  assert.notEqual(second.reconnectHandle, first.reconnectHandle);

  const staleOldClient = await broker.handle(new Request(`http://localhost/takeover/api/frame/${sessionId}`, {
    headers: {
      "x-takeover-client": CLIENT_A,
      "x-mcp-takeover-capability": first.capability
    }
  }), PRINCIPAL_A);
  assert.equal(staleOldClient.status, 404);

  const freshClient = await broker.handle(new Request(`http://localhost/takeover/api/frame/${sessionId}`, {
    headers: {
      "x-takeover-client": CLIENT_B,
      "x-mcp-takeover-capability": second.capability
    }
  }), PRINCIPAL_A);
  assert.equal(freshClient.status, 200);
  assert.deepEqual(calls.at(-1), ["frame", "reconnect-intervention", 4]);
});

test("revoking an intervention aborts its active push frame stream", async () => {
  let observedAbort = false;
  const browser: TakeoverBrowserAdapter = {
    async captureHumanTakeoverFrame() {
      throw new Error("polling fallback should not be used");
    },
    async *streamHumanTakeoverFrames(_interventionId, _epoch, signal) {
      yield {
        data: Buffer.from("initial-frame").toString("base64"),
        width: 640,
        height: 480,
        hostname: "accounts.google.com"
      };
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          observedAbort = true;
          resolve();
          return;
        }
        signal.addEventListener("abort", () => {
          observedAbort = true;
          resolve();
        }, { once: true });
      });
    },
    async tapHumanTakeover() {},
    async scrollHumanTakeover() {},
    async insertHumanTakeoverText() {},
    async pressHumanTakeoverKey() {}
  };
  const broker = new TakeoverBroker(browser, { enabled: true, publicBaseUrl: "https://takeover.example", ttlMs: 60_000 });
  const link = broker.createLink({ id: "revoke-stream-intervention", epoch: 7 }, PRINCIPAL_A);
  assert.ok(link);
  const sessionId = new URL(link).pathname.split("/").at(-1);
  assert.ok(sessionId);
  const capability = await bootstrap(broker, sessionId);
  const response = await broker.handle(new Request(`http://localhost/takeover/api/stream/${sessionId}`, {
    headers: {
      "x-mcp-takeover-capability": capability,
      "x-takeover-client": CLIENT_A
    }
  }), PRINCIPAL_A);
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);

  broker.revokeForIntervention("revoke-stream-intervention");
  let done = false;
  for (let i = 0; i < 8 && !done; i += 1) {
    done = (await reader.read()).done;
  }
  assert.equal(done, true);
  assert.equal(observedAbort, true);
});
