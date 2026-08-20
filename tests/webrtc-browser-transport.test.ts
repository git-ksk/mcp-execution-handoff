import assert from "node:assert/strict";
import test from "node:test";
import { TakeoverBroker, type TakeoverBrowserAdapter } from "../src/browser-takeover/broker.js";
import type {
  WebRtcRuntimeHooks,
  WebRtcSessionDescription,
  WebRtcTakeoverRuntimeBinding,
  WebRtcTakeoverRuntimeProvider
} from "../src/browser-takeover/webrtc-runtime.js";

const PRINCIPAL = "principal-webrtc";
const CLIENT_A = "webrtc-client-a-1234567890";
const CLIENT_B = "webrtc-client-b-1234567890";
const CLIENT_C = "webrtc-client-c-1234567890";
const ORIGIN = "https://takeover.example";
const OFFER: WebRtcSessionDescription = { type: "offer", sdp: "v=0\r\n" };

class FakeWebRtcRuntime implements WebRtcTakeoverRuntimeProvider {
  starts: Array<{ binding: WebRtcTakeoverRuntimeBinding; hooks: WebRtcRuntimeHooks }> = [];
  revokes: string[] = [];

  async start(
    binding: WebRtcTakeoverRuntimeBinding,
    _offer: WebRtcSessionDescription,
    hooks: WebRtcRuntimeHooks
  ): Promise<WebRtcSessionDescription> {
    this.starts.push({ binding, hooks });
    return { type: "answer", sdp: "v=0\r\na=fake-answer\r\n" };
  }

  async reconnect(
    binding: WebRtcTakeoverRuntimeBinding,
    offer: WebRtcSessionDescription,
    hooks: WebRtcRuntimeHooks
  ): Promise<WebRtcSessionDescription> {
    return this.start(binding, offer, hooks);
  }

  async revoke(takeoverSessionId: string): Promise<void> {
    this.revokes.push(takeoverSessionId);
  }

  async revokeForIntervention(interventionId: string): Promise<void> {
    for (const start of this.starts) {
      if (start.binding.interventionId === interventionId) this.revokes.push(start.binding.takeoverSessionId);
    }
  }
}

function noOpBrowser(): TakeoverBrowserAdapter {
  return {
    async captureHumanTakeoverFrame() {
      return { data: "", width: 1, height: 1, hostname: "unused" };
    },
    async tapHumanTakeover() {},
    async scrollHumanTakeover() {},
    async insertHumanTakeoverText() {},
    async pressHumanTakeoverKey() {}
  };
}

function fixture() {
  const runtime = new FakeWebRtcRuntime();
  const broker = new TakeoverBroker(
    noOpBrowser(),
    { enabled: true, publicBaseUrl: ORIGIN, ttlMs: 60_000, reconnectIdleMs: 5_000 },
    undefined,
    runtime
  );
  const link = broker.createWebRtcLink({ id: "webrtc-intervention", epoch: 11 }, PRINCIPAL);
  assert.ok(link);
  const sessionId = new URL(link).pathname.split("/").at(-1);
  assert.ok(sessionId);
  return { broker, runtime, link, sessionId };
}

async function signal(
  broker: TakeoverBroker,
  sessionId: string,
  operation: "claim" | "reconnect",
  clientBinding: string,
  reconnectHandle?: string
) {
  const headers: Record<string, string> = {
    origin: ORIGIN,
    "content-type": "application/json",
    "x-takeover-client": clientBinding
  };
  if (reconnectHandle) headers["x-mcp-takeover-reconnect"] = reconnectHandle;
  return broker.handle(new Request(
    `http://localhost/takeover/api/webrtc-${operation}/${sessionId}`,
    { method: "POST", headers, body: JSON.stringify(OFFER) }
  ), PRINCIPAL);
}

test("WebRTC locator renders direct video/touch UI without legacy operation buttons", async () => {
  const { broker, link } = fixture();
  const page = await broker.handle(new Request(`http://localhost${new URL(link).pathname}`), PRINCIPAL);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<video id="video"/);
  assert.match(html, />Done<\/button>/);
  assert.match(html, /\/takeover\/webrtc-client\.js/);
  assert.doesNotMatch(html, />.*Scroll.*<\/button>/i);
  assert.doesNotMatch(html, />Tab<\/button>/i);
  assert.doesNotMatch(html, />Send<\/button>/i);
  assert.doesNotMatch(html, /data-scroll|id="send"/);

  const client = await broker.handle(new Request("http://localhost/takeover/webrtc-client.js"), PRINCIPAL);
  assert.equal(client.status, 200);
  const script = await client.text();
  assert.match(script, /RTCPeerConnection/);
  assert.match(script, /human-critical/);
  assert.match(script, /human-realtime/);
  assert.match(script, /visibilitychange/);
  assert.match(script, /webrtc-suspend/);
  assert.match(script, /webrtc-.*mode/);
  assert.match(script, /connect\('reconnect'\)/);
  assert.doesNotMatch(script, /localStorage|sessionStorage/);
  assert.doesNotMatch(script, /takeover\/api\/frame|data-scroll/);
  assert.match(script, /#done[\s\S]*takeover\/api\/done[\s\S]*finally\{closePeer\(\)/);
});

test("WebRTC claim is generation-bound and legacy frame/input fallback is closed", async () => {
  const { broker, runtime, sessionId } = fixture();
  const response = await signal(broker, sessionId, "claim", CLIENT_A);
  assert.equal(response.status, 200);
  const body = await response.json() as {
    capability: string;
    reconnectHandle: string;
    clientGeneration: number;
    webrtc: WebRtcSessionDescription;
  };
  assert.equal(body.clientGeneration, 1);
  assert.equal(body.webrtc.type, "answer");
  assert.equal(runtime.starts.length, 1);
  assert.deepEqual(
    {
      id: runtime.starts[0]!.binding.takeoverSessionId,
      intervention: runtime.starts[0]!.binding.interventionId,
      epoch: runtime.starts[0]!.binding.epoch,
      principal: runtime.starts[0]!.binding.principalBinding,
      client: runtime.starts[0]!.binding.clientBinding,
      generation: runtime.starts[0]!.binding.clientGeneration
    },
    { id: sessionId, intervention: "webrtc-intervention", epoch: 11, principal: PRINCIPAL, client: CLIENT_A, generation: 1 }
  );

  const legacyFrame = await broker.handle(new Request(`http://localhost/takeover/api/frame/${sessionId}`, {
    headers: { "x-takeover-client": CLIENT_A, "x-mcp-takeover-capability": body.capability }
  }), PRINCIPAL);
  assert.equal(legacyFrame.status, 404);

  const legacyInput = await broker.handle(new Request(`http://localhost/takeover/api/input/${sessionId}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-takeover-client": CLIENT_A,
      "x-mcp-takeover-capability": body.capability
    },
    body: JSON.stringify({ kind: "tap", x: 1, y: 1 })
  }), PRINCIPAL);
  assert.equal(legacyInput.status, 404);
});

test("background suspend fences stale capability and immediate reconnect requires fresh generation", async () => {
  const { broker, runtime, sessionId } = fixture();
  const firstResponse = await signal(broker, sessionId, "claim", CLIENT_A);
  const first = await firstResponse.json() as { capability: string; reconnectHandle: string; clientGeneration: number };
  assert.equal(first.clientGeneration, 1);

  const firstHooks = runtime.starts[0]!.hooks;
  const endUse = firstHooks.beginInput();
  endUse();

  const suspend = await broker.handle(new Request(`http://localhost/takeover/api/webrtc-suspend/${sessionId}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "x-takeover-client": CLIENT_A,
      "x-mcp-takeover-capability": first.capability
    }
  }), PRINCIPAL);
  assert.equal(suspend.status, 200);
  assert.deepEqual(await suspend.json(), { suspended: true, reconnectRequired: true });
  assert.throws(() => firstHooks.beginInput(), /stale|unavailable/i);

  const staleDone = await broker.handle(new Request(`http://localhost/takeover/api/done/${sessionId}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "x-takeover-client": CLIENT_A,
      "x-mcp-takeover-capability": first.capability
    }
  }), PRINCIPAL);
  assert.equal(staleDone.status, 404);

  const secondResponse = await signal(broker, sessionId, "reconnect", CLIENT_B, first.reconnectHandle);
  assert.equal(secondResponse.status, 200);
  const second = await secondResponse.json() as { capability: string; reconnectHandle: string; clientGeneration: number };
  assert.equal(second.clientGeneration, 2);
  assert.notEqual(second.capability, first.capability);
  assert.notEqual(second.reconnectHandle, first.reconnectHandle);
  assert.equal(runtime.starts.at(-1)!.binding.clientBinding, CLIENT_B);
});

test("unexpected peer disconnect releases only that generation and reconnect stays explicit", async () => {
  const { broker, runtime, sessionId } = fixture();
  const firstResponse = await signal(broker, sessionId, "claim", CLIENT_A);
  const first = await firstResponse.json() as { capability: string; reconnectHandle: string; clientGeneration: number };
  runtime.starts[0]!.hooks.disconnected();

  const sameGeneration = await signal(broker, sessionId, "claim", CLIENT_A);
  assert.equal(sameGeneration.status, 404);

  const secondResponse = await signal(broker, sessionId, "reconnect", CLIENT_C, first.reconnectHandle);
  assert.equal(secondResponse.status, 200);
  const second = await secondResponse.json() as { clientGeneration: number };
  assert.equal(second.clientGeneration, 2);
});

test("Done revokes broker generation and WebRTC runtime without treating it as semantic success", async () => {
  const { broker, runtime, sessionId } = fixture();
  const response = await signal(broker, sessionId, "claim", CLIENT_A);
  const grant = await response.json() as { capability: string };
  const done = await broker.handle(new Request(`http://localhost/takeover/api/done/${sessionId}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "x-takeover-client": CLIENT_A,
      "x-mcp-takeover-capability": grant.capability
    }
  }), PRINCIPAL);
  assert.equal(done.status, 200);
  assert.deepEqual(await done.json(), { done: true });
  assert.ok(runtime.revokes.includes(sessionId));

  const stale = await signal(broker, sessionId, "claim", CLIENT_A);
  assert.equal(stale.status, 404);
});
