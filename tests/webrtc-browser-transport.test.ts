import assert from "node:assert/strict";
import test from "node:test";
import { TakeoverBroker, type TakeoverBrowserAdapter } from "../src/browser-takeover/broker.js";
import type { WebRtcBrowserIceConfiguration } from "../src/browser-takeover/webrtc-ice.js";
import type { WebRtcLatencyComparison, WebRtcLatencySample } from "../src/browser-takeover/webrtc-latency.js";
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
  prepares: WebRtcTakeoverRuntimeBinding[] = [];
  starts: Array<{ binding: WebRtcTakeoverRuntimeBinding; hooks: WebRtcRuntimeHooks }> = [];
  revokes: string[] = [];
  latency: WebRtcLatencySample[] = [];
  nextIce: WebRtcBrowserIceConfiguration = { iceServers: [], relay: "disabled" };

  async prepare(binding: WebRtcTakeoverRuntimeBinding): Promise<WebRtcBrowserIceConfiguration> {
    this.prepares.push({ ...binding });
    return this.nextIce;
  }

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

  recordLatency(sample: WebRtcLatencySample): void {
    this.latency.push(sample);
  }

  latencySnapshot(): WebRtcLatencyComparison {
    const empty = { samples: 0, rtt: { count: 0 }, firstFrame: { count: 0 } };
    return { direct: empty, relay: empty };
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

async function prepare(
  broker: TakeoverBroker,
  sessionId: string,
  operation: "claim" | "reconnect",
  clientBinding: string,
  reconnectHandle?: string
) {
  const headers: Record<string, string> = { origin: ORIGIN, "x-takeover-client": clientBinding };
  if (reconnectHandle) headers["x-mcp-takeover-reconnect"] = reconnectHandle;
  return broker.handle(new Request(
    `http://localhost/takeover/api/webrtc-prepare-${operation}/${sessionId}`,
    { method: "POST", headers }
  ), PRINCIPAL);
}

async function connect(
  broker: TakeoverBroker,
  sessionId: string,
  clientBinding: string,
  capability: string
) {
  return broker.handle(new Request(
    `http://localhost/takeover/api/webrtc-connect/${sessionId}`,
    {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-takeover-client": clientBinding,
        "x-mcp-takeover-capability": capability
      },
      body: JSON.stringify(OFFER)
    }
  ), PRINCIPAL);
}

async function prepareAndConnect(
  broker: TakeoverBroker,
  sessionId: string,
  operation: "claim" | "reconnect",
  clientBinding: string,
  reconnectHandle?: string
) {
  const preparation = await prepare(broker, sessionId, operation, clientBinding, reconnectHandle);
  assert.equal(preparation.status, 200);
  const grant = await preparation.json() as {
    capability: string;
    reconnectHandle: string;
    clientGeneration: number;
    webrtcIce: WebRtcBrowserIceConfiguration;
  };
  const connected = await connect(broker, sessionId, clientBinding, grant.capability);
  assert.equal(connected.status, 200);
  const body = await connected.json() as { webrtc: WebRtcSessionDescription };
  assert.equal(body.webrtc.type, "answer");
  return grant;
}

test("WebRTC locator renders direct touch UI and direct-first relay-capable client without legacy buttons", async () => {
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
  assert.match(script, /new RTCPeerConnection\(\{iceServers:ice\.iceServers,iceTransportPolicy:'all'\}\)/);
  assert.match(script, /webrtc-prepare-/);
  assert.match(script, /webrtc-connect/);
  assert.match(script, /Trying secure relay/);
  assert.match(script, /Live · /);
  assert.match(script, /candidateType==='relay'/);
  assert.match(script, /webrtc-metrics/);
  assert.match(script, /requestVideoFrameCallback/);
  assert.match(script, /currentRoundTripTime/);
  assert.match(script, /human-critical/);
  assert.match(script, /human-realtime/);
  assert.match(script, /visibilitychange/);
  assert.match(script, /webrtc-suspend/);
  assert.match(script, /connect\('reconnect'\)/);
  assert.doesNotMatch(script, /localStorage|sessionStorage/);
  assert.doesNotMatch(script, /takeover\/api\/frame|data-scroll/);
  assert.doesNotMatch(script, /candidate\.address|candidate\.ip|turn\.cloudflare\.com/);
  assert.match(script, /#done[\s\S]*takeover\/api\/done[\s\S]*finally\{closePeer\(\)/);
});

test("WebRTC prepare binds ICE to generation before offer and legacy frame/input fallback stays closed", async () => {
  const { broker, runtime, sessionId } = fixture();
  runtime.nextIce = {
    iceServers: [{ urls: "stun:relay.invalid:3478" }],
    relay: "available"
  };
  const preparation = await prepare(broker, sessionId, "claim", CLIENT_A);
  assert.equal(preparation.status, 200);
  const grant = await preparation.json() as {
    capability: string;
    reconnectHandle: string;
    clientGeneration: number;
    webrtcIce: WebRtcBrowserIceConfiguration;
  };
  assert.equal(grant.clientGeneration, 1);
  assert.equal(grant.webrtcIce.relay, "available");
  assert.equal(runtime.prepares.length, 1);
  assert.equal(runtime.starts.length, 0);
  assert.equal(runtime.prepares[0]!.clientGeneration, 1);

  const connected = await connect(broker, sessionId, CLIENT_A, grant.capability);
  assert.equal(connected.status, 200);
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
    headers: { "x-takeover-client": CLIENT_A, "x-mcp-takeover-capability": grant.capability }
  }), PRINCIPAL);
  assert.equal(legacyFrame.status, 404);

  const legacyInput = await broker.handle(new Request(`http://localhost/takeover/api/input/${sessionId}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-takeover-client": CLIENT_A,
      "x-mcp-takeover-capability": grant.capability
    },
    body: JSON.stringify({ kind: "tap", x: 1, y: 1 })
  }), PRINCIPAL);
  assert.equal(legacyInput.status, 404);

  const obsoleteOneStep = await broker.handle(new Request(`http://localhost/takeover/api/webrtc-claim/${sessionId}`, {
    method: "POST", headers: { origin: ORIGIN, "x-takeover-client": CLIENT_A }
  }), PRINCIPAL);
  assert.equal(obsoleteOneStep.status, 404);
});

test("background suspend fences stale capability and reconnect prepares a fresh generation", async () => {
  const { broker, runtime, sessionId } = fixture();
  const first = await prepareAndConnect(broker, sessionId, "claim", CLIENT_A);
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

  const staleConnect = await connect(broker, sessionId, CLIENT_A, first.capability);
  assert.equal(staleConnect.status, 404);

  const second = await prepareAndConnect(broker, sessionId, "reconnect", CLIENT_B, first.reconnectHandle);
  assert.equal(second.clientGeneration, 2);
  assert.notEqual(second.capability, first.capability);
  assert.notEqual(second.reconnectHandle, first.reconnectHandle);
  assert.equal(runtime.prepares.at(-1)!.clientBinding, CLIENT_B);
  assert.equal(runtime.prepares.at(-1)!.clientGeneration, 2);
  assert.equal(runtime.starts.at(-1)!.binding.clientBinding, CLIENT_B);
});

test("unexpected peer disconnect releases only that generation and stale peer cannot revive", async () => {
  const { broker, runtime, sessionId } = fixture();
  const first = await prepareAndConnect(broker, sessionId, "claim", CLIENT_A);
  runtime.starts[0]!.hooks.disconnected();

  const sameGeneration = await prepare(broker, sessionId, "claim", CLIENT_A);
  assert.equal(sameGeneration.status, 404);
  const staleConnect = await connect(broker, sessionId, CLIENT_A, first.capability);
  assert.equal(staleConnect.status, 404);

  const second = await prepareAndConnect(broker, sessionId, "reconnect", CLIENT_C, first.reconnectHandle);
  assert.equal(second.clientGeneration, 2);
});

test("TURN issuance unavailable remains explicit direct-only preparation instead of relay-only or locator revocation", async () => {
  const { broker, runtime, sessionId } = fixture();
  runtime.nextIce = { iceServers: [], relay: "unavailable" };
  const response = await prepare(broker, sessionId, "claim", CLIENT_A);
  assert.equal(response.status, 200);
  const body = await response.json() as { capability: string; webrtcIce: WebRtcBrowserIceConfiguration };
  assert.deepEqual(body.webrtcIce, { iceServers: [], relay: "unavailable" });
  const connected = await connect(broker, sessionId, CLIENT_A, body.capability);
  assert.equal(connected.status, 200);
});

test("latency endpoint accepts only bounded path metrics and never accepts network identifiers", async () => {
  const { broker, runtime, sessionId } = fixture();
  const grant = await prepareAndConnect(broker, sessionId, "claim", CLIENT_A);
  const metrics = await broker.handle(new Request(`http://localhost/takeover/api/webrtc-metrics/${sessionId}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-takeover-client": CLIENT_A,
      "x-mcp-takeover-capability": grant.capability
    },
    body: JSON.stringify({ path: "relay", rttMs: 51.27, firstFrameMs: 322.94 })
  }), PRINCIPAL);
  assert.equal(metrics.status, 200);
  assert.deepEqual(runtime.latency, [{ path: "relay", rttMs: 51.3, firstFrameMs: 322.9 }]);

  const rejected = await broker.handle(new Request(`http://localhost/takeover/api/webrtc-metrics/${sessionId}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-takeover-client": CLIENT_A,
      "x-mcp-takeover-capability": grant.capability
    },
    body: JSON.stringify({ path: "direct", rttMs: 2, address: "192.0.2.1" })
  }), PRINCIPAL);
  assert.equal(rejected.status, 400);
  assert.equal(runtime.latency.length, 1);
});

test("Done revokes broker generation and WebRTC runtime without treating relay as semantic success", async () => {
  const { broker, runtime, sessionId } = fixture();
  const grant = await prepareAndConnect(broker, sessionId, "claim", CLIENT_A);
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

  const stale = await prepare(broker, sessionId, "claim", CLIENT_A);
  assert.equal(stale.status, 404);
});
