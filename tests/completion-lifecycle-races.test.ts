import assert from "node:assert/strict";
import test from "node:test";
import { TakeoverBroker, type TakeoverBrowserAdapter } from "../src/browser-takeover/broker.js";
import { ExperimentalWebSocketTakeoverChannel } from "../src/experimental/websocket-takeover.js";
import type { WebRtcBrowserIceConfiguration } from "../src/browser-takeover/webrtc-ice.js";
import type { WebRtcLatencyComparison, WebRtcLatencySample } from "../src/browser-takeover/webrtc-latency.js";
import type { WebRtcDiagnosticEvent, WebRtcDiagnosticsSnapshot } from "../src/browser-takeover/webrtc-diagnostics.js";
import type {
  WebRtcRuntimeHooks,
  WebRtcSessionDescription,
  WebRtcTakeoverRuntimeBinding,
  WebRtcTakeoverRuntimeProvider
} from "../src/browser-takeover/webrtc-runtime.js";

const PRINCIPAL = "principal-completion-races";
const CLIENT = "completion-race-client-1234567890";
const ORIGIN = "https://takeover.example";
const OFFER: WebRtcSessionDescription = { type: "offer", sdp: "v=0\r\n" };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function createBlockedPongChannel() {
  const pongGate = deferred();
  const controls: object[] = [];
  const calls = { begin: 0, end: 0, complete: 0, release: 0 };
  const channel = new ExperimentalWebSocketTakeoverChannel({
    binding: {
      interventionId: "wss-completion-race",
      epoch: 1,
      principalBinding: PRINCIPAL,
      clientBinding: CLIENT,
      clientGeneration: 1
    },
    inputPolicy: { tap: true, scroll: true, text: false, key: false },
    peer: {
      async sendControl(message) {
        controls.push(message);
        if (message.kind === "pong") await pongGate.promise;
      },
      async sendFrame() {},
      bufferedAmount() { return 0; },
      async close() {}
    },
    lease: {
      async beginUse() { calls.begin += 1; },
      async endUse() { calls.end += 1; },
      async complete() { calls.complete += 1; },
      async release() { calls.release += 1; }
    },
    async onInput() {}
  });
  return { channel, controls, calls, pongGate };
}

test("pending WSS application pong cannot block Human Done authority completion", async () => {
  const h = createBlockedPongChannel();
  await h.channel.start();
  const ping = h.channel.receiveText(JSON.stringify({ kind: "ping", nonce: "held" }));
  await flushAsync();
  const done = h.channel.receiveText(JSON.stringify({ kind: "done" }));
  try {
    await flushAsync();
    assert.equal(h.calls.complete, 1, "Done must reach shared authority while pong delivery is stalled");
    assert.equal(h.channel.state, "closed");
  } finally {
    h.pongGate.resolve();
    await Promise.allSettled([ping, done]);
  }
});

test("pending WSS application pong cannot block explicit revoke authority release", async () => {
  const h = createBlockedPongChannel();
  await h.channel.start();
  const ping = h.channel.receiveText(JSON.stringify({ kind: "ping", nonce: "held" }));
  await flushAsync();
  const revoke = h.channel.revoke();
  try {
    await flushAsync();
    assert.equal(h.calls.release, 1, "revoke must release shared authority while pong delivery is stalled");
    assert.equal(h.channel.state, "revoked");
  } finally {
    h.pongGate.resolve();
    await Promise.allSettled([ping, revoke]);
  }
});

class ControlledRevokeWebRtcRuntime implements WebRtcTakeoverRuntimeProvider {
  readonly prepares: WebRtcTakeoverRuntimeBinding[] = [];
  readonly starts: Array<{ binding: WebRtcTakeoverRuntimeBinding; hooks: WebRtcRuntimeHooks }> = [];
  readonly revokes: string[] = [];
  readonly latency: WebRtcLatencySample[] = [];
  readonly diagnostics: WebRtcDiagnosticEvent[] = [];
  private revokeGate: ReturnType<typeof deferred> | undefined;
  private failNext = false;

  holdRevoke(): void {
    this.revokeGate = deferred();
  }

  releaseRevoke(): void {
    this.revokeGate?.resolve();
    this.revokeGate = undefined;
  }

  failNextRevoke(): void {
    this.failNext = true;
  }

  async prepare(binding: WebRtcTakeoverRuntimeBinding): Promise<WebRtcBrowserIceConfiguration> {
    this.prepares.push({ ...binding });
    return { iceServers: [], relay: "disabled" };
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
    if (this.failNext) {
      this.failNext = false;
      throw new Error("synthetic revoke failure");
    }
    const gate = this.revokeGate;
    if (gate) await gate.promise;
  }

  async revokeForIntervention(interventionId: string): Promise<void> {
    for (const start of this.starts) {
      if (start.binding.interventionId === interventionId) await this.revoke(start.binding.takeoverSessionId);
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

async function createWebRtcCompletionFixture(runtime: ControlledRevokeWebRtcRuntime) {
  let completedCalls = 0;
  const broker = new TakeoverBroker(
    noOpBrowser(),
    { enabled: true, publicBaseUrl: ORIGIN, ttlMs: 60_000, reconnectIdleMs: 5_000 },
    undefined,
    runtime,
    { completed() { completedCalls += 1; } }
  );
  const link = broker.createWebRtcLink({ id: "webrtc-completion-race", epoch: 9 }, PRINCIPAL);
  assert.ok(link);
  const sessionId = new URL(link).pathname.split("/").at(-1);
  assert.ok(sessionId);

  const page = await broker.handle(new Request(`http://localhost${new URL(link).pathname}`), PRINCIPAL);
  assert.equal(page.status, 200);
  const completionCapability = /data-completion="([A-Za-z0-9_-]{32,128})"/.exec(await page.text())?.[1];
  assert.ok(completionCapability);

  const prepared = await broker.handle(new Request(
    `http://localhost/takeover/api/webrtc-prepare-claim/${sessionId}`,
    { method: "POST", headers: { origin: ORIGIN, "x-takeover-client": CLIENT } }
  ), PRINCIPAL);
  assert.equal(prepared.status, 200);
  const grant = await prepared.json() as { capability: string };

  const connected = await broker.handle(new Request(
    `http://localhost/takeover/api/webrtc-connect/${sessionId}`,
    {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-takeover-client": CLIENT,
        "x-mcp-takeover-capability": grant.capability
      },
      body: JSON.stringify(OFFER)
    }
  ), PRINCIPAL);
  assert.equal(connected.status, 200);

  const complete = () => broker.handle(new Request(
    `http://localhost/takeover/api/complete/${sessionId}`,
    {
      method: "POST",
      headers: { origin: ORIGIN, "x-mcp-takeover-completion": completionCapability }
    }
  ), PRINCIPAL);

  return {
    broker,
    sessionId,
    complete,
    completedCalls: () => completedCalls
  };
}

test("duplicate WebRTC completion joins pending runtime teardown before reporting success", async () => {
  const runtime = new ControlledRevokeWebRtcRuntime();
  const h = await createWebRtcCompletionFixture(runtime);
  runtime.holdRevoke();

  const first = h.complete();
  await flushAsync();
  assert.equal(runtime.revokes.length, 1);
  assert.equal(h.completedCalls(), 0);

  let secondSettled = false;
  const second = h.complete().then((response) => {
    secondSettled = true;
    return response;
  });
  try {
    await flushAsync();
    assert.equal(h.completedCalls(), 0, "consumer completion must wait for confirmed runtime teardown");
    assert.equal(secondSettled, false, "duplicate completion must join the pending teardown");
    assert.equal(runtime.revokes.length, 1, "duplicate completion must not start a second concurrent revoke");
  } finally {
    runtime.releaseRevoke();
  }

  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.deepEqual(await firstResponse.json(), { done: true, alreadyDone: false });
  assert.deepEqual(await secondResponse.json(), { done: true, alreadyDone: true });
  assert.equal(h.completedCalls(), 1);
  assert.equal(runtime.revokes.length, 1);
});

test("WebRTC completion retries failed runtime teardown before consumer completion", async () => {
  const runtime = new ControlledRevokeWebRtcRuntime();
  const h = await createWebRtcCompletionFixture(runtime);
  runtime.failNextRevoke();

  const first = await h.complete();
  assert.equal(first.status, 503);
  assert.deepEqual(await first.json(), { error: "takeover_runtime_revoke_failed", revoked: true });
  assert.equal(runtime.revokes.length, 1);
  assert.equal(h.completedCalls(), 0);

  const retry = await h.complete();
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), { done: true, alreadyDone: true });
  assert.equal(runtime.revokes.length, 2, "retry must confirm runtime teardown instead of bypassing it");
  assert.equal(h.completedCalls(), 1);
});
