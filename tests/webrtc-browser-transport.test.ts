import assert from "node:assert/strict";
import test from "node:test";
import { TakeoverBroker, type TakeoverBrowserAdapter } from "../src/browser-takeover/broker.js";
import type { WebRtcBrowserIceConfiguration } from "../src/browser-takeover/webrtc-ice.js";
import type { WebRtcLatencyComparison, WebRtcLatencySample } from "../src/browser-takeover/webrtc-latency.js";
import type { WebRtcDiagnosticEvent, WebRtcDiagnosticsSnapshot } from "../src/browser-takeover/webrtc-diagnostics.js";
import type {
  WebRtcRuntimeHooks,
  WebRtcHumanInputPolicy,
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
  diagnostics: WebRtcDiagnosticEvent[] = [];
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

  recordLatency(_takeoverSessionId: string, sample: WebRtcLatencySample): void {
    this.latency.push(sample);
  }

  latencySnapshot(): WebRtcLatencyComparison {
    const empty = { samples: 0, rtt: { count: 0 }, firstFrame: { count: 0 } };
    return { direct: empty, relay: empty };
  }

  recordDiagnostic(event: WebRtcDiagnosticEvent): void {
    this.diagnostics.push(structuredClone(event));
  }

  diagnosticsSnapshot(): WebRtcDiagnosticsSnapshot {
    return { events: structuredClone(this.diagnostics) };
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

class DeferredStartWebRtcRuntime extends FakeWebRtcRuntime {
  private releaseStart!: () => void;
  private markStartEntered!: () => void;
  readonly startEntered = new Promise<void>((resolve) => { this.markStartEntered = resolve; });
  private readonly startGate = new Promise<void>((resolve) => { this.releaseStart = resolve; });

  override async start(
    binding: WebRtcTakeoverRuntimeBinding,
    _offer: WebRtcSessionDescription,
    hooks: WebRtcRuntimeHooks
  ): Promise<WebRtcSessionDescription> {
    this.starts.push({ binding, hooks });
    this.markStartEntered();
    await this.startGate;
    return { type: "answer", sdp: "v=0\r\na=fake-answer\r\n" };
  }

  finishStart(): void {
    this.releaseStart();
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

function fixture(
  targetProcessId?: number,
  targetWindowId?: number,
  inputPolicy?: WebRtcHumanInputPolicy
) {
  const runtime = new FakeWebRtcRuntime();
  const broker = new TakeoverBroker(
    noOpBrowser(),
    { enabled: true, publicBaseUrl: ORIGIN, ttlMs: 60_000, reconnectIdleMs: 5_000 },
    undefined,
    runtime
  );
  const link = broker.createWebRtcLink(
    { id: "webrtc-intervention", epoch: 11 },
    PRINCIPAL,
    targetProcessId === undefined ? undefined : {
      processId: targetProcessId,
      ...(targetWindowId === undefined ? {} : { windowId: targetWindowId })
    },
    inputPolicy
  );
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

async function diagnostic(
  broker: TakeoverBroker,
  sessionId: string,
  clientBinding: string,
  capability: string,
  body: unknown
) {
  return broker.handle(new Request(
    `http://localhost/takeover/api/webrtc-diagnostics/${sessionId}`,
    {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-takeover-client": clientBinding,
        "x-mcp-takeover-capability": capability
      },
      body: JSON.stringify(body)
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
    inputPolicy: WebRtcHumanInputPolicy;
  };
  const connected = await connect(broker, sessionId, clientBinding, grant.capability);
  assert.equal(connected.status, 200);
  const body = await connected.json() as { webrtc: WebRtcSessionDescription };
  assert.equal(body.webrtc.type, "answer");
  return grant;
}


test("WebRTC runtime binding keeps an exact optional host process/window private and generation-bound", async () => {
  const { broker, runtime, sessionId } = fixture(4242, 7331);
  const grant = await prepareAndConnect(broker, sessionId, "claim", CLIENT_A);
  assert.equal(grant.clientGeneration, 1);
  assert.equal(runtime.prepares[0]!.targetProcessId, 4242);
  assert.equal(runtime.prepares[0]!.targetWindowId, 7331);
  assert.equal(runtime.starts[0]!.binding.targetProcessId, 4242);
  assert.equal(runtime.starts[0]!.binding.targetWindowId, 7331);
});

test("WebRTC input policy is session-bound and server-enforced before host input", async () => {
  const policy: WebRtcHumanInputPolicy = { tap: true, scroll: false, text: false, key: false };
  const { broker, runtime, sessionId } = fixture(undefined, undefined, policy);
  const grant = await prepareAndConnect(broker, sessionId, "claim", CLIENT_A);
  assert.deepEqual(grant.inputPolicy, policy);

  const hooks = runtime.starts[0]!.hooks;
  const endTap = hooks.beginInput({ kind: "tap", x: 0.5, y: 0.5 });
  endTap();
  assert.throws(
    () => hooks.beginInput({ kind: "text", text: "blocked" }),
    /not allowed/i
  );
  assert.throws(
    () => hooks.beginInput({ kind: "key", key: "Enter" }),
    /not allowed/i
  );

  const widened = broker.createWebRtcLink(
    { id: "webrtc-intervention", epoch: 11 },
    PRINCIPAL,
    undefined,
    { tap: true, scroll: true, text: true, key: true }
  );
  assert.equal(widened, undefined, "an active Browser Handoff policy cannot be widened in place");
});

test("WebRTC broker rejects invalid exact host window targets", () => {
  const runtime = new FakeWebRtcRuntime();
  const broker = new TakeoverBroker(
    noOpBrowser(),
    { enabled: true, publicBaseUrl: ORIGIN, ttlMs: 60_000 },
    undefined,
    runtime
  );
  assert.equal(broker.createWebRtcLink(
    { id: "webrtc-invalid-window", epoch: 1 },
    PRINCIPAL,
    { processId: 4242, windowId: 0 }
  ), undefined);
});

test("WebRTC locator renders direct touch UI and direct-first relay-capable client without legacy buttons", async () => {
  const { broker, link } = fixture();
  const page = await broker.handle(new Request(`http://localhost${new URL(link).pathname}`), PRINCIPAL);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<video id="video"/);
  assert.match(html, /webkit-playsinline/);
  assert.match(html, /opacity:0/);
  assert.match(html, />Done<\/button>/);
  assert.match(html, /id="keyboard-open"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /id="keyboard-backspace"/);
  assert.match(html, /aria-label="Backspace"/);
  assert.match(html, /id="zoom"/);
  assert.match(html, /aria-label="Zoom remote view"/);
  assert.match(html, />1×<\/button>/);
  assert.match(html, /transform-origin:50% 50%/);
  assert.match(html, /will-change:transform/);
  assert.match(html, /\/takeover\/webrtc-client\.js/);
  assert.doesNotMatch(html, />.*Scroll.*<\/button>/i);
  assert.doesNotMatch(html, />Tab<\/button>/i);
  assert.doesNotMatch(html, />Send<\/button>/i);
  assert.doesNotMatch(html, /data-scroll|id="send"/);

  const client = await broker.handle(new Request("http://localhost/takeover/webrtc-client.js"), PRINCIPAL);
  assert.equal(client.status, 200);
  const script = await client.text();
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /new RTCPeerConnection\(\{iceServers:ice\.iceServers,iceTransportPolicy:'all'\}\)/);
  assert.match(script, /webrtc-prepare-/);
  assert.match(script, /webrtc-connect/);
  assert.match(script, /Trying secure relay/);
  assert.match(script, /candidate\.type==='relay'/);
  assert.doesNotMatch(script, /ice timeout/);
  assert.match(script, /Live · /);
  assert.match(script, /candidateType==='relay'/);
  assert.match(script, /webrtc-metrics/);
  assert.match(script, /webrtc-diagnostics/);
  assert.match(script, /iceCandidateCounts/);
  assert.match(script, /browser\.gather\.complete/);
  assert.match(script, /void postDiagnostic\(\{stage:'browser\.gather\.complete'/);
  assert.doesNotMatch(script, /await postDiagnostic\(\{stage:'browser\.gather\.complete'/);
  assert.match(script, /jitterBufferDelay/);
  assert.match(script, /jitterBufferTargetDelay/);
  assert.match(script, /jitterBufferMinimumDelay/);
  assert.match(script, /totalDecodeTime/);
  assert.match(script, /totalProcessingDelay/);
  assert.match(script, /captureTime/);
  assert.match(script, /receiveTime/);
  assert.match(script, /expectedDisplayTime/);
  assert.match(script, /senderTimelineToDisplayMs/);
  assert.match(script, /senderTimelineToReceiveMs/);
  assert.match(script, /inputAckMs/);
  assert.match(script, /inputMetricsSamplesSent>=6/);
  assert.match(script, /touchEventsAvailable=\('ontouchstart' in window\)\|\|\(Number\(navigator\.maxTouchPoints\)\|\|0\)>0/);
  assert.match(script, /addEventListener\('touchstart'/);
  assert.match(script, /addEventListener\('touchmove'/);
  assert.match(script, /addEventListener\('touchend'/);
  assert.match(script, /passive:false/);
  assert.match(script, /touchWithId/);
  assert.match(script, /MAX_VIEW_SCALE=4/);
  assert.match(script, /function applyViewTransform\(scale,panX,panY\)/);
  assert.match(script, /matrix\('\+viewScale\+',0,0,'\+viewScale\+','\+viewPanX\+','\+viewPanY\+'\)/);
  assert.match(script, /function beginPinch\(list\)/);
  assert.match(script, /function updatePinch\(list\)/);
  assert.match(script, /event\.touches\.length===2\)\{beginPinch\(event\.touches\)/);
  assert.match(script, /if\(pinch\)\{updatePinch\(event\.touches\);event\.preventDefault\(\);return\}/);
  assert.match(script, /localPan:viewScale>1/);
  assert.match(script, /if\(gesture\.localPan\).*applyViewTransform/);
  assert.match(script, /if\(g\.moved\)\{if\(g\.localPan\)return;sendGestureScroll/);
  assert.match(script, /zoomButton\.addEventListener\('click'/);
  assert.match(script, /cycleViewScale\(\)/);
  assert.match(script, /window\.addEventListener\('orientationchange',scheduleOrientationReset\)/);
  assert.match(script, /closePeer\(\)[\s\S]*resetViewTransform\(\)/);
  assert.match(script, /function mapPoint\(event\)\{const r=video\.getBoundingClientRect\(\)/);
  assert.match(script, /sendGestureScroll/);
  assert.match(script, /deltaY:Math\.max\(-2000,Math\.min\(2000,dy\*2\)\)/);
  assert.doesNotMatch(script, /deltaY:Math\.max\(-2000,Math\.min\(2000,-dy\*2\)\)/);
  assert.match(script, /finishGesture/);
  assert.match(script, /if\(touchEventsAvailable&&event\.pointerType==='touch'\)return/);
  assert.match(script, /video\.setPointerCapture/);
  assert.match(script, /editableRegions/);
  assert.match(script, /applyEditableRegions/);
  assert.match(script, /pointIsEditable/);
  assert.match(script, /performance\.now\(\)-editableRegionsAt>1000/);
  assert.match(script, /g\.editable\|\|keyboardMode/);
  assert.match(script, /armKeyboardFallback/);
  assert.match(script, /if\(touchEventsAvailable\)\{if\(!stopped\)setKeyboardControlsVisible\(true\);return\}/);
  assert.match(script, /setKeyboardControlsVisible\(touchEventsAvailable\)/);
  assert.match(script, /keyboardBackspace\.style\.display=display/);
  assert.match(script, /function focusKeyboard\(\)/);
  assert.match(script, /keyboard\.focus\(\{preventScroll:true\}\)/);
  assert.match(script, /keyboard\.focus\(\)/);
  assert.match(script, /let .*keyboardMode=false/);
  assert.match(script, /function setKeyboardMode\(enabled\)/);
  assert.match(script, /keyboardOpen\.setAttribute\('aria-pressed',enabled\?'true':'false'\)/);
  assert.match(script, /else if\(!keyboardMode\)\{keyboard\.blur\(\)\}/);
  assert.match(script, /keyboardOpen\.addEventListener\('click',[\s\S]*setKeyboardMode\(!keyboardMode\)/);
  assert.match(script, /keyboardBackspace\.addEventListener\('click'/);
  assert.match(script, /sendCritical\(\{kind:'key',key:'Backspace'\}\)\)setKeyboardMode\(true\)/);
  assert.match(script, /sendCritical\(\{kind:'key',key:'Backspace'\}\)/);
  assert.doesNotMatch(script, /probeEditable|phase==='probe'/);
  assert.match(script, /reportInputAck/);
  assert.doesNotMatch(script, /frameAgeMs|captureToReceiveMs/);
  assert.match(script, /metricsSamplesSent>=12/);
  assert.match(script, /requestVideoFrameCallback/);
  assert.match(script, /video\.style\.opacity='1'/);
  assert.match(script, /video\.style\.opacity='0'/);
  assert.match(script, /currentRoundTripTime/);
  assert.match(script, /human-critical/);
  assert.match(script, /human-realtime/);
  assert.match(script, /beforeinput/);
  assert.match(script, /insertText/);
  assert.match(script, /insertReplacementText/);
  assert.match(script, /insertFromPaste/);
  assert.match(script, /keydown/);
  assert.match(script, /deleteContentBackward/);
  assert.match(script, /const MARK='_'/);
  assert.match(script, /value\.startsWith\(MARK\)\?value\.slice\(MARK\.length\):value/);
  assert.match(script, /insertLineBreak/);
  assert.match(script, /event\.preventDefault\(\)/);
  assert.match(script, /visibilitychange/);
  assert.match(script, /webrtc-suspend/);
  assert.match(script, /connect\('reconnect'\)/);
  assert.doesNotMatch(script, /localStorage|sessionStorage/);
  assert.doesNotMatch(script, /takeover\/api\/frame|data-scroll/);
  assert.doesNotMatch(script, /candidate\.address|candidate\.ip|turn\.cloudflare\.com/);
  assert.match(script, /inputPolicy=\{tap:true,scroll:true,text:true,key:true\}/);
  assert.match(script, /function inputAllowed\(kind\)/);
  assert.match(script, /x-mcp-takeover-completion/);
  assert.match(script, /takeover\/api\/complete/);
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
    inputPolicy: WebRtcHumanInputPolicy;
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

test("background suspend waits for an in-flight WebRTC connect before revoking that generation", async () => {
  const runtime = new DeferredStartWebRtcRuntime();
  const broker = new TakeoverBroker(
    noOpBrowser(),
    { enabled: true, publicBaseUrl: ORIGIN, ttlMs: 60_000, reconnectIdleMs: 5_000 },
    undefined,
    runtime
  );
  const link = broker.createWebRtcLink({ id: "webrtc-connect-suspend-race", epoch: 12 }, PRINCIPAL);
  assert.ok(link);
  const sessionId = new URL(link).pathname.split("/").at(-1);
  assert.ok(sessionId);

  const preparation = await prepare(broker, sessionId, "claim", CLIENT_A);
  assert.equal(preparation.status, 200);
  const grant = await preparation.json() as { capability: string };

  const connecting = connect(broker, sessionId, CLIENT_A, grant.capability);
  await runtime.startEntered;
  let suspendSettled = false;
  const suspending = broker.handle(new Request(`http://localhost/takeover/api/webrtc-suspend/${sessionId}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "x-takeover-client": CLIENT_A,
      "x-mcp-takeover-capability": grant.capability
    }
  }), PRINCIPAL).then((response) => { suspendSettled = true; return response; });

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(suspendSettled, false, "suspend must not revoke the peer while answer creation is in flight");
  assert.deepEqual(runtime.revokes, []);

  runtime.finishStart();
  const connected = await connecting;
  const suspended = await suspending;
  assert.equal(connected.status, 200);
  assert.equal(suspended.status, 200);
  assert.deepEqual(await suspended.json(), { suspended: true, reconnectRequired: true });
  assert.deepEqual(runtime.revokes, [sessionId]);
});

test("background suspend fences stale capability and reconnect prepares a fresh generation", async () => {
  const { broker, runtime, sessionId } = fixture();
  const first = await prepareAndConnect(broker, sessionId, "claim", CLIENT_A);
  assert.equal(first.clientGeneration, 1);

  const firstHooks = runtime.starts[0]!.hooks;
  const endUse = firstHooks.beginInput({ kind: "tap", x: 0.5, y: 0.5 });
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
  assert.throws(() => firstHooks.beginInput({ kind: "tap", x: 0.5, y: 0.5 }), /stale|unavailable/i);

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

test("setup diagnostics are bounded to non-identifying stage, candidate-type counts, state and timing", async () => {
  const { broker, runtime, sessionId } = fixture();
  const preparation = await prepare(broker, sessionId, "claim", CLIENT_A);
  assert.equal(preparation.status, 200);
  const grant = await preparation.json() as { capability: string };

  assert.deepEqual(runtime.diagnostics.map((event) => event.stage), [
    "broker.prepare.request",
    "broker.prepare.success"
  ]);

  const accepted = await diagnostic(broker, sessionId, CLIENT_A, grant.capability, {
    stage: "browser.gather.complete",
    candidateCounts: { host: 1, srflx: 1, prflx: 0, relay: 0 },
    durationMs: 23.456
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(runtime.diagnostics.at(-1), {
    stage: "browser.gather.complete",
    candidateCounts: { host: 1, srflx: 1, prflx: 0, relay: 0 },
    durationMs: 23.5
  });

  const leakedAddress = await diagnostic(broker, sessionId, CLIENT_A, grant.capability, {
    stage: "browser.gather.complete",
    candidateCounts: { host: 1, srflx: 1, prflx: 0, relay: 0 },
    address: "192.0.2.1"
  });
  assert.equal(leakedAddress.status, 400);

  const leakedCandidate = await diagnostic(broker, sessionId, CLIENT_A, grant.capability, {
    stage: "browser.gather.complete",
    candidateCounts: { host: 1, srflx: 1, prflx: 0, relay: 0 },
    candidate: "candidate body must never cross this boundary"
  });
  assert.equal(leakedCandidate.status, 400);

  const badState = await diagnostic(broker, sessionId, CLIENT_A, grant.capability, {
    stage: "browser.peer.state",
    state: "checking"
  });
  assert.equal(badState.status, 400);
});

test("broker diagnostics distinguish prepare from connect without storing session identity", async () => {
  const { broker, runtime, sessionId } = fixture();
  await prepareAndConnect(broker, sessionId, "claim", CLIENT_A);
  assert.deepEqual(runtime.diagnostics.map((event) => event.stage), [
    "broker.prepare.request",
    "broker.prepare.success",
    "broker.connect.request",
    "broker.connect.success"
  ]);
  assert.doesNotMatch(JSON.stringify(runtime.diagnostics), /session|principal|client|intervention|192\.0\.2\.1|candidate:/i);
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
    body: JSON.stringify({
      path: "relay", rttMs: 51.27, firstFrameMs: 322.94, jitterMs: 8.88, jitterBufferMs: 77.77,
      jitterBufferTargetMs: 91.11, jitterBufferMinimumMs: 22.22, avgDecodeMs: 6.66, avgProcessingMs: 88.88,
      senderTimelineToDisplayMs: 222.22, senderTimelineToReceiveMs: 44.44, receiveToDisplayMs: 177.78,
      frameDecodeMs: 5.55, compositorMs: 16.67, inputAckMs: 55.55
    })
  }), PRINCIPAL);
  assert.equal(metrics.status, 200);
  assert.deepEqual(runtime.latency, [{
    path: "relay", rttMs: 51.3, firstFrameMs: 322.9, jitterMs: 8.9, jitterBufferMs: 77.8,
    jitterBufferTargetMs: 91.1, jitterBufferMinimumMs: 22.2, avgDecodeMs: 6.7, avgProcessingMs: 88.9,
    senderTimelineToDisplayMs: 222.2, senderTimelineToReceiveMs: 44.4, receiveToDisplayMs: 177.8,
    frameDecodeMs: 5.6, compositorMs: 16.7, inputAckMs: 55.6
  }]);

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
  const spoofedHostMetric = await broker.handle(new Request(`http://localhost/takeover/api/webrtc-metrics/${sessionId}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", "x-takeover-client": CLIENT_A, "x-mcp-takeover-capability": grant.capability },
    body: JSON.stringify({ path: "direct", rttMs: 2, hostEncodeMs: 1 })
  }), PRINCIPAL);
  assert.equal(spoofedHostMetric.status, 400);
  assert.equal(runtime.latency.length, 1);
});

test("completion-only Done survives WebRTC disconnect and reload without reviving stale input", async () => {
  const { broker, runtime, sessionId, link } = fixture();
  const initialPage = await broker.handle(new Request(`http://localhost${new URL(link).pathname}`), PRINCIPAL);
  assert.equal(initialPage.status, 200);
  const initialHtml = await initialPage.text();
  const initialCompletion = /data-completion="([A-Za-z0-9_-]{32,128})"/.exec(initialHtml)?.[1];
  assert.ok(initialCompletion);

  const grant = await prepareAndConnect(broker, sessionId, "claim", CLIENT_A);
  const oldHooks = runtime.starts[0]!.hooks;
  oldHooks.disconnected();
  assert.throws(
    () => oldHooks.beginInput({ kind: "tap", x: 0.5, y: 0.5 }),
    /stale|unavailable/i
  );

  const reloadPage = await broker.handle(new Request(`http://localhost${new URL(link).pathname}`), PRINCIPAL);
  assert.equal(reloadPage.status, 200);
  const reloadHtml = await reloadPage.text();
  const reloadCompletion = /data-completion="([A-Za-z0-9_-]{32,128})"/.exec(reloadHtml)?.[1];
  assert.equal(reloadCompletion, initialCompletion);

  const completionAsMediaCapability = await connect(broker, sessionId, CLIENT_B, initialCompletion);
  assert.equal(completionAsMediaCapability.status, 404);

  const wrongPrincipal = await broker.handle(new Request(`http://localhost/takeover/api/complete/${sessionId}`, {
    method: "POST",
    headers: { origin: ORIGIN, "x-mcp-takeover-completion": initialCompletion }
  }), "principal-other");
  assert.equal(wrongPrincipal.status, 404);

  const completed = await broker.handle(new Request(`http://localhost/takeover/api/complete/${sessionId}`, {
    method: "POST",
    headers: { origin: ORIGIN, "x-mcp-takeover-completion": initialCompletion }
  }), PRINCIPAL);
  assert.equal(completed.status, 200);
  assert.deepEqual(await completed.json(), { done: true, alreadyDone: false });
  assert.ok(runtime.revokes.includes(sessionId));

  const duplicate = await broker.handle(new Request(`http://localhost/takeover/api/complete/${sessionId}`, {
    method: "POST",
    headers: { origin: ORIGIN, "x-mcp-takeover-completion": initialCompletion }
  }), PRINCIPAL);
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { done: true, alreadyDone: true });

  const stalePrepare = await prepare(broker, sessionId, "claim", CLIENT_A);
  assert.equal(stalePrepare.status, 404);
  assert.notEqual(grant.capability, initialCompletion);
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
