import assert from "node:assert/strict";
import test from "node:test";
import { TakeoverBroker, type TakeoverBrowserAdapter } from "../src/browser-takeover/broker.js";
import { browserHumanInputClientSource } from "../src/browser-takeover/browser-human-input.js";
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

class SuspendableFakeWebRtcRuntime extends FakeWebRtcRuntime {
  suspends: string[] = [];

  async suspend(takeoverSessionId: string): Promise<void> {
    this.suspends.push(takeoverSessionId);
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


class FakeBrowserElement {
  textContent = "";
  value = "";
  disabled = false;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  videoWidth = 1280;
  videoHeight = 720;
  srcObject: unknown = null;
  paused = false;

  addEventListener(type: string, listener: (event: Record<string, unknown>) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string): void {
    const event = {
      preventDefault() {},
      stopPropagation() {},
      persisted: false,
      touches: [],
      changedTouches: []
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | undefined {
    return this.attributes.get(name);
  }

  blur(): void {}
  focus(): void {}
  setSelectionRange(): void {}
  setPointerCapture(): void {}
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: 1280, height: 720 };
  }
  play(): Promise<void> { return Promise.resolve(); }
  pause(): void { this.paused = true; }
}

type CompletionClientHarness = {
  status: FakeBrowserElement;
  done: FakeBrowserElement;
  rejectPrepare(error?: Error): void;
  resolveCompletion(ok: boolean): void;
  completionRequests(): number;
};

async function completionClientHarness(broker: TakeoverBroker): Promise<CompletionClientHarness> {
  const response = await broker.handle(new Request("http://localhost/takeover/webrtc-client.js"), PRINCIPAL);
  assert.equal(response.status, 200);
  const script = await response.text();
  const elements = new Map<string, FakeBrowserElement>();
  for (const selector of [
    "#status", "#video", ".screen", "#zoom", "#aim", "#aim-tap", "#aim-crosshair",
    "#keyboard", "#keyboard-open", "#keyboard-backspace", "#done"
  ]) elements.set(selector, new FakeBrowserElement());
  const done = elements.get("#done")!;
  done.dataset.completion = "completion-capability";
  const status = elements.get("#status")!;
  status.textContent = "Connecting…";

  let rejectPrepare!: (error: Error) => void;
  const preparePromise = new Promise<never>((_resolve, reject) => { rejectPrepare = reject; });
  let resolveCompletion!: (response: { ok: boolean }) => void;
  const completionPromise = new Promise<{ ok: boolean }>((resolve) => { resolveCompletion = resolve; });
  let completeCount = 0;
  const fetchStub = (url: string): Promise<unknown> => {
    if (url.includes("/takeover/api/webrtc-prepare-claim/")) return preparePromise;
    if (url.includes("/takeover/api/complete/")) {
      completeCount += 1;
      return completionPromise;
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  };

  const documentStub = {
    visibilityState: "visible",
    activeElement: undefined,
    querySelector(selector: string) { return elements.get(selector); },
    addEventListener() {}
  };
  const windowStub = { addEventListener() {} };
  const cryptoStub = { getRandomValues(bytes: Uint8Array) { bytes.fill(7); return bytes; } };
  const noTimer = () => 1;
  const clearTimer = () => undefined;
  const run = new Function(
    "location", "document", "window", "navigator", "crypto", "btoa", "performance", "fetch",
    "TextEncoder", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "MediaStream", "RTCPeerConnection",
    script
  );
  run(
    { pathname: "/takeover/browser-completion-test" },
    documentStub,
    windowStub,
    { maxTouchPoints: 0 },
    cryptoStub,
    (value: string) => Buffer.from(value, "binary").toString("base64"),
    { now: () => 1 },
    fetchStub,
    TextEncoder,
    noTimer,
    clearTimer,
    noTimer,
    clearTimer,
    class {},
    class { constructor() { throw new Error("peer should not start before prepare resolves"); } }
  );
  return {
    status,
    done,
    rejectPrepare(error = new Error("connection failed")) { rejectPrepare(error); },
    resolveCompletion(ok: boolean) { resolveCompletion({ ok }); },
    completionRequests() { return completeCount; }
  };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}


type ReconnectClientHarness = {
  status: FakeBrowserElement;
  video: FakeBrowserElement;
  done: FakeBrowserElement;
  peers: FakeLifecyclePeer[];
  setVisibility(value: "visible" | "hidden"): void;
  dispatchDocument(type: string): void;
  dispatchWindow(type: string, persisted?: boolean): void;
  disconnectCurrent(): void;
  sendCriticalState(state: string): void;
  resolveSuspend(): void;
  suspendRequests(): number;
  reconnectPrepareRequests(): number;
};

class FakeLifecycleChannel {
  readonly readyState = "open";
  readonly bufferedAmount = 0;
  readonly sent: string[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  send(value: string): void { this.sent.push(value); }
}

class FakeLifecyclePeer {
  connectionState = "new";
  iceGatheringState = "complete";
  localDescription: { type: "offer"; sdp: string } | null = null;
  ontrack: ((event: { streams: unknown[]; track: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  readonly critical = new FakeLifecycleChannel();
  readonly realtime = new FakeLifecycleChannel();

  addEventListener(): void {}
  removeEventListener(): void {}
  addTransceiver(): void {}
  createDataChannel(label: string): FakeLifecycleChannel {
    return label === "human-critical" ? this.critical : this.realtime;
  }
  async createOffer(): Promise<{ type: "offer"; sdp: string }> { return { type: "offer", sdp: "v=0\r\n" }; }
  async setLocalDescription(offer: { type: "offer"; sdp: string }): Promise<void> { this.localDescription = offer; }
  async setRemoteDescription(): Promise<void> {
    this.connectionState = "connected";
    queueMicrotask(() => this.onconnectionstatechange?.());
  }
  async getStats(): Promise<Map<string, unknown>> { return new Map(); }
  close(): void { this.connectionState = "closed"; }
  disconnect(): void {
    this.connectionState = "disconnected";
    this.onconnectionstatechange?.();
  }
}

async function reconnectClientHarness(
  broker: TakeoverBroker,
  reconnectConflicts = 0
): Promise<ReconnectClientHarness> {
  const response = await broker.handle(new Request("http://localhost/takeover/webrtc-client.js"), PRINCIPAL);
  assert.equal(response.status, 200);
  const script = await response.text();
  const elements = new Map<string, FakeBrowserElement>();
  for (const selector of [
    "#status", "#video", ".screen", "#zoom", "#aim", "#aim-tap", "#aim-crosshair",
    "#keyboard", "#keyboard-open", "#keyboard-backspace", "#done"
  ]) elements.set(selector, new FakeBrowserElement());
  elements.get("#done")!.dataset.completion = "completion-capability";
  const status = elements.get("#status")!;
  status.textContent = "Connecting…";

  const documentListeners = new Map<string, Array<(event: { persisted?: boolean }) => void>>();
  const windowListeners = new Map<string, Array<(event: { persisted?: boolean }) => void>>();
  let visibilityState: "visible" | "hidden" = "visible";
  const addListener = (
    target: Map<string, Array<(event: { persisted?: boolean }) => void>>,
    type: string,
    listener: (event: { persisted?: boolean }) => void
  ) => target.set(type, [...(target.get(type) ?? []), listener]);
  const documentStub = {
    get visibilityState() { return visibilityState; },
    activeElement: undefined,
    querySelector(selector: string) { return elements.get(selector); },
    addEventListener(type: string, listener: (event: { persisted?: boolean }) => void) {
      addListener(documentListeners, type, listener);
    }
  };
  const windowStub = {
    addEventListener(type: string, listener: (event: { persisted?: boolean }) => void) {
      addListener(windowListeners, type, listener);
    }
  };

  let resolveSuspendResponse!: (response: Response) => void;
  let suspendPromise = new Promise<Response>((resolve) => { resolveSuspendResponse = resolve; });
  let suspendCount = 0;
  let reconnectPrepareCount = 0;
  let conflictsRemaining = reconnectConflicts;
  let generation = 1;
  const peers: FakeLifecyclePeer[] = [];
  const PeerCtor = class extends FakeLifecyclePeer {
    constructor() { super(); peers.push(this); }
  };
  const grant = () => ({
    capability: `capability-${generation}`.padEnd(32, "x"),
    reconnectHandle: `reconnect-${generation}`.padEnd(40, "y"),
    clientGeneration: generation,
    inputPolicy: { tap: true, scroll: true, text: true, key: true },
    webrtcIce: { iceServers: [], relay: "disabled" }
  });
  const fetchStub = async (url: string): Promise<Response> => {
    if (url.includes("/takeover/api/webrtc-prepare-claim/")) return Response.json(grant());
    if (url.includes("/takeover/api/webrtc-prepare-reconnect/")) {
      reconnectPrepareCount += 1;
      if (conflictsRemaining > 0) {
        conflictsRemaining -= 1;
        return Response.json({ error: "takeover_client_active", retryAfterMs: 750 }, { status: 409 });
      }
      generation += 1;
      return Response.json(grant());
    }
    if (url.includes("/takeover/api/webrtc-connect/")) {
      return Response.json({ webrtc: { type: "answer", sdp: "v=0\r\n" } });
    }
    if (url.includes("/takeover/api/webrtc-suspend/")) {
      suspendCount += 1;
      return suspendPromise;
    }
    if (url.includes("/takeover/api/webrtc-state/")) {
      return Response.json({ error: "takeover_unavailable" }, { status: 404 });
    }
    if (url.includes("/takeover/api/webrtc-diagnostics/") || url.includes("/takeover/api/webrtc-metrics/")) {
      return Response.json({ accepted: true });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  let randomSeed = 1;
  const cryptoStub = {
    getRandomValues(bytes: Uint8Array) {
      bytes.fill(randomSeed++ % 251 || 1);
      return bytes;
    }
  };
  let clock = 1;
  let timerId = 0;
  const setTimeoutStub = (callback: () => void, ms = 0) => {
    const id = ++timerId;
    if (ms < 10_000) queueMicrotask(callback);
    return id;
  };
  const run = new Function(
    "location", "document", "window", "navigator", "crypto", "btoa", "performance", "fetch",
    "TextEncoder", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "MediaStream", "RTCPeerConnection",
    script
  );
  run(
    { pathname: "/takeover/browser-reconnect-test" },
    documentStub,
    windowStub,
    { maxTouchPoints: 0 },
    cryptoStub,
    (value: string) => Buffer.from(value, "binary").toString("base64"),
    { now: () => clock++ },
    fetchStub,
    TextEncoder,
    setTimeoutStub,
    () => undefined,
    () => ++timerId,
    () => undefined,
    class {},
    PeerCtor
  );
  await flushAsync();
  await flushAsync();
  assert.equal(peers.length, 1);

  return {
    status,
    video: elements.get("#video")!,
    done: elements.get("#done")!,
    peers,
    setVisibility(value) { visibilityState = value; },
    dispatchDocument(type) {
      for (const listener of documentListeners.get(type) ?? []) listener({});
    },
    dispatchWindow(type, persisted = false) {
      for (const listener of windowListeners.get(type) ?? []) listener({ persisted });
    },
    disconnectCurrent() { peers.at(-1)!.disconnect(); },
    sendCriticalState(state) {
      peers.at(-1)!.critical.onmessage?.({ data: JSON.stringify({ kind: "state", state }) });
    },
    resolveSuspend() {
      resolveSuspendResponse(Response.json({ suspended: true, reconnectRequired: true }));
      suspendPromise = Promise.resolve(Response.json({ suspended: true, reconnectRequired: true }));
    },
    suspendRequests() { return suspendCount; },
    reconnectPrepareRequests() { return reconnectPrepareCount; }
  };
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
  const endDown = hooks.beginInput({ kind: "pointer_button", button: "primary", state: "down", x: 0.5, y: 0.5 });
  endDown();
  const endUp = hooks.beginInput({ kind: "pointer_button", button: "primary", state: "up", x: 0.5, y: 0.5 });
  endUp();
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


test("WebRTC Done immediately fences local Human controls and remains one-shot while completion is pending", async () => {
  const { broker } = fixture();
  const harness = await completionClientHarness(broker);

  harness.done.dispatch("touchend");
  assert.equal(harness.done.disabled, true);
  assert.equal(harness.done.getAttribute("aria-disabled"), "true");
  assert.equal(harness.done.textContent, "Closing…");
  assert.equal(harness.status.textContent, "Closing…");
  assert.equal(harness.completionRequests(), 1);

  harness.done.dispatch("click");
  harness.done.dispatch("touchend");
  assert.equal(harness.completionRequests(), 1, "duplicate Done gestures must remain local no-ops");

  harness.rejectPrepare();
  await flushAsync();
  assert.equal(harness.status.textContent, "Closing…", "connection failure must not overwrite in-flight completion state");

  harness.resolveCompletion(true);
  await flushAsync();
  assert.equal(harness.done.disabled, true);
  assert.equal(harness.done.textContent, "Closed");
  assert.equal(harness.status.textContent, "Remote control closed. Return to the requesting workflow.");
  assert.equal(harness.completionRequests(), 1);
});

test("WebRTC Done failure remains fail-closed and shows completion-specific status without restoring authority", async () => {
  const { broker } = fixture();
  const harness = await completionClientHarness(broker);

  harness.done.dispatch("click");
  assert.equal(harness.done.disabled, true);
  assert.equal(harness.status.textContent, "Closing…");
  harness.resolveCompletion(false);
  await flushAsync();

  assert.equal(harness.done.disabled, true);
  assert.equal(harness.done.textContent, "Closed");
  assert.equal(harness.status.textContent, "Completion unavailable. Remote control remains closed.");
  harness.done.dispatch("click");
  assert.equal(harness.completionRequests(), 1, "a failed completion response must not restore the consumed capability");

  harness.rejectPrepare();
  await flushAsync();
  assert.equal(harness.status.textContent, "Completion unavailable. Remote control remains closed.");
});



test("LocalAuthentication target terminal fences input and waits for consumer verification", async () => {
  const runtime = new FakeWebRtcRuntime();
  const broker = new TakeoverBroker(
    noOpBrowser(),
    { enabled: true, publicBaseUrl: ORIGIN, ttlMs: 60_000, reconnectIdleMs: 5_000 },
    undefined,
    runtime
  );
  const intervention = { id: "webrtc-local-auth-terminal", epoch: 17 } as const;
  const link = broker.createWebRtcLink(
    intervention,
    PRINCIPAL,
    { processId: 4242 },
    { tap: true, scroll: false, text: true, key: true },
    { terminalTargetBehavior: "verifying" }
  );
  assert.ok(link);
  const sessionId = new URL(link).pathname.split("/").at(-1)!;

  const activePage = await broker.handle(new Request(link), PRINCIPAL);
  const activeHtml = await activePage.text();
  const completionCapability = /data-completion="([A-Za-z0-9_-]+)"/.exec(activeHtml)?.[1];
  assert.ok(completionCapability);

  const grant = await prepareAndConnect(broker, sessionId, "claim", CLIENT_A);
  const hooks = runtime.starts[0]!.hooks;
  assert.equal(hooks.terminal?.("target_missing"), true);
  assert.throws(
    () => hooks.beginInput({ kind: "tap", x: 0.5, y: 0.5 }),
    /stale|unavailable/i,
    "target terminal must fence the exact Human generation before cleanup"
  );

  const pendingState = await broker.handle(
    new Request(`http://localhost/takeover/api/webrtc-state/${sessionId}`),
    PRINCIPAL
  );
  assert.equal(pendingState.status, 200);
  assert.deepEqual(await pendingState.json(), { state: "verifying" });

  const pendingPage = await broker.handle(new Request(link), PRINCIPAL);
  const pendingHtml = await pendingPage.text();
  assert.match(pendingHtml, /Verifying… Remote input is disabled/);
  assert.doesNotMatch(pendingHtml, /webrtc-client\.js/);
  assert.doesNotMatch(pendingHtml, /data-completion=/);

  const staleDone = await broker.handle(new Request(
    `http://localhost/takeover/api/complete/${sessionId}`,
    {
      method: "POST",
      headers: { origin: ORIGIN, "x-mcp-takeover-completion": completionCapability }
    }
  ), PRINCIPAL);
  assert.equal(staleDone.status, 409);
  assert.deepEqual(await staleDone.json(), { error: "takeover_verifying", verifying: true });

  const reconnect = await prepare(broker, sessionId, "reconnect", CLIENT_B, grant.reconnectHandle);
  assert.equal(reconnect.status, 409);
  assert.deepEqual(await reconnect.json(), { error: "takeover_verifying", verifying: true });
  assert.equal(runtime.prepares.length, 1, "verifying must never spawn a replacement WebRTC host");

  assert.equal(await broker.completeWebRtcAfterVerification(intervention), true);
  const closedState = await broker.handle(
    new Request(`http://localhost/takeover/api/webrtc-state/${sessionId}`),
    PRINCIPAL
  );
  assert.equal(closedState.status, 200);
  assert.deepEqual(await closedState.json(), { state: "closed" });
  const closedPage = await broker.handle(new Request(link), PRINCIPAL);
  assert.match(await closedPage.text(), /Remote control closed/);
});

test("ordinary WebRTC target terminal keeps existing reconnect semantics", async () => {
  const { broker, runtime, sessionId } = fixture();
  await prepareAndConnect(broker, sessionId, "claim", CLIENT_A);
  assert.equal(runtime.starts[0]!.hooks.terminal?.("target_missing"), false);
  const state = await broker.handle(
    new Request(`http://localhost/takeover/api/webrtc-state/${sessionId}`),
    PRINCIPAL
  );
  assert.equal(state.status, 404);
});

test("WebRTC verifying signal clears the stale frame and disables local Human controls", async () => {
  const { broker } = fixture();
  const harness = await reconnectClientHarness(broker);
  harness.video.srcObject = { stale: true };

  harness.sendCriticalState("verifying");
  assert.equal(harness.video.style.opacity, "0");
  assert.equal(harness.video.srcObject, null);
  assert.equal(harness.video.paused, true);
  assert.equal(harness.done.disabled, true);
  assert.equal(harness.done.textContent, "Verifying…");
  assert.equal(harness.status.textContent, "Verifying… Remote input is disabled.");
  assert.deepEqual(harness.peers.flatMap((peer) => peer.critical.sent), []);
});

test("Browser reconnect waits for the exact generation release and coalesces Safari lifecycle triggers", async () => {
  const { broker } = fixture();
  const harness = await reconnectClientHarness(broker);

  harness.disconnectCurrent();
  await flushAsync();
  assert.equal(harness.suspendRequests(), 1);
  assert.equal(harness.reconnectPrepareRequests(), 0);

  harness.setVisibility("visible");
  harness.dispatchDocument("visibilitychange");
  harness.dispatchWindow("pageshow", true);
  await flushAsync();
  assert.equal(
    harness.reconnectPrepareRequests(),
    0,
    "foreground events must wait for the old generation release to settle"
  );

  harness.resolveSuspend();
  await flushAsync();
  await flushAsync();
  await flushAsync();
  assert.equal(harness.reconnectPrepareRequests(), 1, "concurrent Safari lifecycle triggers must share one reconnect");
  assert.equal(harness.peers.length, 2);
  assert.deepEqual(harness.peers.flatMap((peer) => peer.critical.sent), [], "Human input must not replay across reconnect");
  assert.match(harness.status.textContent, /Connected .*waiting for video|Live/);
});



test("Browser reconnect consumes bounded 409 retry hint and recovers without a reconnect loop", async () => {
  const { broker } = fixture();
  const harness = await reconnectClientHarness(broker, 1);

  harness.disconnectCurrent();
  await flushAsync();
  harness.resolveSuspend();
  await flushAsync();
  await flushAsync();
  await flushAsync();
  await flushAsync();

  assert.equal(harness.reconnectPrepareRequests(), 2, "one active-lease conflict should produce one bounded retry");
  assert.equal(harness.peers.length, 2, "409 must not create an extra peer before a generation is granted");
  assert.match(harness.status.textContent, /Connected .*waiting for video|Live/);
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
  assert.match(html, /\.done\{[^}]*pointer-events:auto/);
  assert.match(html, /\.done\{[^}]*touch-action:manipulation/);
  assert.match(html, /id="keyboard-open"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /id="keyboard-backspace"/);
  assert.match(html, /maxlength="512"/);
  assert.match(html, /aria-label="Backspace"/);
  assert.match(html, /id="zoom"/);
  assert.match(html, /aria-label="Zoom remote view"/);
  assert.match(html, />1×<\/button>/);
  assert.match(html, /id="aim"/);
  assert.match(html, /aria-label="Aim precise remote tap"/);
  assert.match(html, /id="aim-crosshair"/);
  assert.match(html, /id="aim-tap"/);
  assert.match(html, /aria-label="Tap aimed remote point"/);
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
  assert.match(script, /localPan:aimMode\|\|viewScale>1/);
  assert.match(script, /if\(gesture\.localPan\).*applyViewTransform/);
  assert.match(script, /if\(g\.moved\)\{if\(g\.localPan\)return;sendGestureScroll/);
  assert.match(script, /zoomButton\.addEventListener\('click'/);
  assert.match(script, /cycleViewScale\(\)/);
  assert.match(script, /function setAimMode\(enabled\)/);
  assert.match(script, /if\(aimMode&&viewScale<MAX_VIEW_SCALE\)applyViewTransform\(MAX_VIEW_SCALE,viewPanX,viewPanY\)/);
  assert.match(script, /function tapAimTarget\(\)/);
  assert.match(script, /if\(aimMode\)return/);
  assert.match(script, /if\(aimMode\)\{event\.preventDefault\(\);return\}/);
  assert.match(script, /clientX:r\.left\+r\.width\/2,clientY:r\.top\+r\.height\/2/);
  assert.match(script, /aimButton\.addEventListener\('click'/);
  assert.match(script, /aimTapButton\.addEventListener\('click'/);
  assert.match(script, /function sendPrimaryTap\(point\)/);
  assert.match(script, /kind:'pointer_button',button:'primary',state:'down'/);
  assert.match(script, /kind:'pointer_button',button:'primary',state:'up'/);
  assert.match(script, /setTimeout\(function\(\)\{primaryReleaseTimer=0;releasePrimaryButton\(\)\},20\)/);
  assert.doesNotMatch(script, /sendCritical\(\{kind:'tap',x:p\.x,y:p\.y\}\)/);
  assert.match(script, /setAimControlsVisible\(\)/);
  assert.match(script, /window\.addEventListener\('orientationchange',scheduleOrientationReset\)/);
  assert.match(script, /closePeer\(\)[\s\S]*resetViewTransform\(\)/);
  assert.match(script, /function mapPoint\(event\)\{const r=video\.getBoundingClientRect\(\)/);
  assert.match(script, /sendGestureScroll/);
  assert.ok(script.includes(browserHumanInputClientSource()));
  assert.match(script, /const browserScrollDelta=/);
  assert.match(script, /const browserScrollDeltaY=/);
  assert.match(script, /const browserWebRtcScrollDelta=/);
  assert.match(script, /deltaX:browserWebRtcScrollDelta\(dx\),deltaY:browserWebRtcScrollDelta\(dy\)/);
  assert.match(script, /deltaX:browserWebRtcScrollDelta\(finalDx\),deltaY:browserWebRtcScrollDelta\(finalDy\)/);
  assert.doesNotMatch(script, /deltaY:Math\.max\(-2000,Math\.min\(2000,dy\*2\)\)/);
  assert.match(script, /finishGesture/);
  assert.match(script, /if\(touchEventsAvailable&&event\.pointerType==='touch'\)return/);
  assert.match(script, /video\.setPointerCapture/);
  assert.match(script, /editableRegions/);
  assert.match(script, /applyEditableRegions/);
  assert.doesNotMatch(script, /pointIsEditable/);
  assert.doesNotMatch(script, /editable:pointIsEditable/);
  assert.match(script, /if\(keyboardMode\)focusKeyboard\(\)/);
  assert.doesNotMatch(script, /g\.editable\|\|keyboardMode/);
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
  assert.doesNotMatch(script, /else if\(!keyboardMode\)\{keyboard\.blur\(\)\}/);
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
  assert.match(script, /event\.inputType==='insertText'/);
  assert.match(script, /insertReplacementText/);
  assert.match(script, /event\.inputType==='insertFromPaste'/);
  assert.match(script, /keydown/);
  assert.match(script, /deleteContentBackward/);
  assert.doesNotMatch(script, /const MARK='_'/);
  assert.doesNotMatch(script, /keyboardMirror|syncKeyboardValue/);
  assert.match(script, /function resetKeyboardBuffer\(\)/);
  assert.match(script, /function commitKeyboardText\(text\)/);
  assert.match(script, /function suppressTrailingKeyboardInput\(\)/);
  assert.match(script, /compositionend',[\s\S]*settleKeyboardComposition/);
  assert.match(script, /compositionPhase='idle'/);
  assert.match(script, /keyboardInputReleaseTimer=setTimeout/);
  assert.match(script, /browserImeKeyboardEventIsCompositionControlled\(compositionPhase,event\.isComposing,Number\(event\.keyCode\)\|\|0\)/);
  assert.match(script, /keyboard\.addEventListener\('input'/);
  assert.match(script, /commitKeyboardText\(event\.data\)/);
  assert.doesNotMatch(script, /compositionend',function\(event\).*sendCritical\(\{kind:'text'/);
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
  assert.match(script, /async function completeHuman\(\)/);
  assert.match(script, /function consumeDoneGesture\(event\)\{event\.preventDefault\(\);event\.stopPropagation\(\);void completeHuman\(\)\}/);
  assert.match(script, /doneButton\.addEventListener\('touchstart',[\s\S]*event\.stopPropagation\(\)[\s\S]*passive:true/);
  assert.match(script, /doneButton\.addEventListener\('touchend',consumeDoneGesture,\{passive:false\}\)/);
  assert.match(script, /doneButton\.addEventListener\('click',consumeDoneGesture\)/);
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

test("background suspend prefers runtime lifecycle suspension over full host revoke when supported", async () => {
  const runtime = new SuspendableFakeWebRtcRuntime();
  const broker = new TakeoverBroker(
    noOpBrowser(),
    { enabled: true, publicBaseUrl: ORIGIN, ttlMs: 60_000, reconnectIdleMs: 5_000 },
    undefined,
    runtime
  );
  const link = broker.createWebRtcLink({ id: "webrtc-host-preserving-suspend", epoch: 12 }, PRINCIPAL);
  assert.ok(link);
  const sessionId = new URL(link).pathname.split("/").at(-1);
  assert.ok(sessionId);

  const first = await prepareAndConnect(broker, sessionId, "claim", CLIENT_A);
  const response = await broker.handle(new Request(`http://localhost/takeover/api/webrtc-suspend/${sessionId}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "x-takeover-client": CLIENT_A,
      "x-mcp-takeover-capability": first.capability
    }
  }), PRINCIPAL);

  assert.equal(response.status, 200);
  assert.deepEqual(runtime.suspends, [sessionId]);
  assert.deepEqual(runtime.revokes, []);
  assert.throws(() => runtime.starts[0]!.hooks.beginInput({ kind: "tap", x: 0.5, y: 0.5 }), /stale|unavailable/i);
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

test("reconnect active-lease conflict is bounded and peer loss releases the exact stale generation", async () => {
  const { broker, runtime, sessionId } = fixture();
  const first = await prepareAndConnect(broker, sessionId, "claim", CLIENT_A);

  const conflict = await prepare(broker, sessionId, "reconnect", CLIENT_B, first.reconnectHandle);
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: "takeover_client_active", retryAfterMs: 500 });
  assert.deepEqual(runtime.diagnostics.slice(-2).map((event) => event.stage), [
    "broker.prepare.failure",
    "broker.reconnect.conflict.active_lease"
  ]);

  runtime.starts[0]!.hooks.disconnected();
  assert.equal(runtime.diagnostics.at(-1)?.stage, "broker.generation.release.peer_loss");

  const second = await prepareAndConnect(broker, sessionId, "reconnect", CLIENT_B, first.reconnectHandle);
  assert.equal(second.clientGeneration, 2);
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
  assert.equal(runtime.diagnostics.at(-1)?.stage, "broker.generation.release.suspend");
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

test("claimed WebRTC completion route survives media ttl while mutable input stays expired", async () => {
  const runtime = new FakeWebRtcRuntime();
  const broker = new TakeoverBroker(
    noOpBrowser(),
    {
      enabled: true,
      publicBaseUrl: ORIGIN,
      ttlMs: 1_000,
      reconnectIdleMs: 250,
      completionGraceMs: 1_500
    },
    undefined,
    runtime
  );
  const link = broker.createWebRtcLink(
    { id: "intervention-media-expiry-completion", epoch: 3 },
    PRINCIPAL,
    { processId: 4242, windowId: 31337 }
  );
  assert.ok(link);
  const sessionId = new URL(link).pathname.split("/").at(-1)!;

  const page = await broker.handle(new Request(`http://localhost${new URL(link).pathname}`), PRINCIPAL);
  assert.equal(page.status, 200);
  const completion = /data-completion="([A-Za-z0-9_-]{32,128})"/.exec(await page.text())?.[1];
  assert.ok(completion);

  const claimed = await prepare(broker, sessionId, "claim", CLIENT_A);
  assert.equal(claimed.status, 200);

  await new Promise((resolve) => setTimeout(resolve, 1_100));

  const completionPage = await broker.handle(
    new Request(`http://localhost/takeover/${sessionId}`),
    PRINCIPAL
  );
  assert.equal(completionPage.status, 200);
  assert.match(await completionPage.text(), /data-completion=/);

  const stalePrepare = await prepare(broker, sessionId, "claim", CLIENT_A);
  assert.equal(stalePrepare.status, 404);

  const completed = await broker.handle(new Request(`http://localhost/takeover/api/complete/${sessionId}`, {
    method: "POST",
    headers: { origin: ORIGIN, "x-mcp-takeover-completion": completion }
  }), PRINCIPAL);
  assert.equal(completed.status, 200);
  assert.deepEqual(await completed.json(), { done: true, alreadyDone: false });
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

test("verified consumer completion returns terminal reconnect without spawning another host", async () => {
  const { broker, runtime, sessionId, link } = fixture();
  const first = await prepareAndConnect(broker, sessionId, "claim", CLIENT_A);
  assert.equal(runtime.starts.length, 1);

  assert.equal(await broker.completeWebRtcAfterVerification({ id: "webrtc-intervention", epoch: 11 }), true);
  assert.ok(runtime.revokes.includes(sessionId));

  const reconnect = await prepare(broker, sessionId, "reconnect", CLIENT_B, first.reconnectHandle);
  assert.equal(reconnect.status, 410);
  assert.deepEqual(await reconnect.json(), { error: "takeover_completed", completed: true });

  const wrongPrincipal = await broker.handle(new Request(
    `http://localhost/takeover/api/webrtc-prepare-reconnect/${sessionId}`,
    { method: "POST", headers: {
      origin: ORIGIN,
      "x-takeover-client": CLIENT_B,
      "x-mcp-takeover-reconnect": first.reconnectHandle
    } }
  ), "principal-other");
  assert.equal(wrongPrincipal.status, 404);
  assert.equal(runtime.prepares.length, 1, "completed reconnect must not prepare new ICE/runtime state");
  assert.equal(runtime.starts.length, 1, "completed reconnect must not spawn/start another host");

  const page = await broker.handle(new Request(`http://localhost${new URL(link).pathname}`), PRINCIPAL);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Remote control closed/);
  assert.doesNotMatch(await (await broker.handle(new Request(`http://localhost${new URL(link).pathname}`), PRINCIPAL)).text(), /webrtc-client\.js/);
});

test("verified consumer completion survives prior WebRTC route cleanup without reviving media", async () => {
  const { broker, runtime, sessionId, link } = fixture();
  const page = await broker.handle(new Request(`http://localhost${new URL(link).pathname}`), PRINCIPAL);
  const completion = /data-completion="([A-Za-z0-9_-]{32,128})"/.exec(await page.text())?.[1];
  assert.ok(completion);

  const grant = await prepareAndConnect(broker, sessionId, "claim", CLIENT_A);
  const humanDone = await broker.handle(new Request(`http://localhost/takeover/api/complete/${sessionId}`, {
    method: "POST",
    headers: { origin: ORIGIN, "x-mcp-takeover-completion": completion }
  }), PRINCIPAL);
  assert.equal(humanDone.status, 200);
  assert.equal((await prepare(broker, sessionId, "reconnect", CLIENT_B, grant.reconnectHandle)).status, 404);

  assert.equal(await broker.completeWebRtcAfterVerification({ id: "webrtc-intervention", epoch: 11 }), true);
  const terminalPage = await broker.handle(new Request(`http://localhost${new URL(link).pathname}`), PRINCIPAL);
  assert.equal(terminalPage.status, 200);
  assert.match(await terminalPage.text(), /Remote control closed/);
  const terminalReconnect = await prepare(broker, sessionId, "reconnect", CLIENT_B, grant.reconnectHandle);
  assert.equal(terminalReconnect.status, 410);
  assert.deepEqual(await terminalReconnect.json(), { error: "takeover_completed", completed: true });
  assert.equal(runtime.starts.length, 1, "verified terminal recovery must not spawn another host");
});
