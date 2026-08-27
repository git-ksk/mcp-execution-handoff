import assert from "node:assert/strict";
import test from "node:test";
import { RTCPeerConnection, type RTCDataChannel } from "werift";
import {
  defineExecutionAdapter,
  ExecutionHandoffRuntime,
  ExecutionHandoffState,
  HandoffCheckpointError,
  type HandoffCheckpoint,
  type HandoffCheckpointStore,
  type InterventionStatus,
  type ResumePolicy,
} from "../src/core/index.js";
import { BrowserHandoffAdapter } from "../src/browser-takeover/browser-handoff-adapter.js";
import { WindowHandoffAdapter } from "../src/window-takeover/window-handoff-adapter.js";
import {
  TerminalHandoffAdapter,
  TerminalHandoffAdapterError,
  type TerminalHandoffInterventionRef,
} from "../src/terminal-takeover/terminal-handoff-adapter.js";

const PRINCIPAL = "principal-restart-conformance-1234567890";
const ACTION_DIGEST = "action-digest-restart-1234567890";
const ORIGIN = "https://restart-handoff.example.test";
const TERMINAL_PRINCIPAL = "a".repeat(64);
const TERMINAL_CLIENT = "b".repeat(32);
const ALL_INPUT = { tap: true, scroll: true, text: true, key: true } as const;
const POINTER_ONLY = { tap: true, scroll: true, text: false, key: false } as const;

class MemoryCheckpointStore implements HandoffCheckpointStore {
  value: unknown;
  write(checkpoint: Readonly<HandoffCheckpoint>): void { this.value = structuredClone(checkpoint); }
  read(): unknown { return structuredClone(this.value); }
  clear(): void { this.value = undefined; }
}

class FailingCheckpointStore extends MemoryCheckpointStore {
  override write(): void { throw new Error("checkpoint write interrupted"); }
}

type CoreIntervention = {
  id: string;
  status: InterventionStatus;
  epoch: number;
  resumePolicy: ResumePolicy;
  updatedAt: number;
};

function stateAdapter(state: ExecutionHandoffState<never, "restart_fixture">) {
  return defineExecutionAdapter("restart.fixture", {
    getResourceEpoch: () => state.getResourceEpoch(),
    getActiveIntervention: (): CoreIntervention | undefined => {
      const active = state.getActive();
      if (!active) return undefined;
      return {
        id: active.id,
        status: active.status,
        epoch: active.epoch,
        resumePolicy: active.resumePolicy,
        updatedAt: active.updatedAt,
      };
    },
    claimHumanControl: (id: string) => {
      const value = state.claimHuman(id);
      return { id: value.id, status: value.status, epoch: value.epoch, resumePolicy: value.resumePolicy, updatedAt: value.updatedAt };
    },
    markHumanControlComplete: (id: string) => {
      const value = state.markHumanComplete(id);
      return { id: value.id, status: value.status, epoch: value.epoch, resumePolicy: value.resumePolicy, updatedAt: value.updatedAt };
    },
    verifyHumanIntervention: async (id: string) => {
      const value = state.markVerified(id);
      return { id: value.id, status: value.status, epoch: value.epoch, resumePolicy: value.resumePolicy, updatedAt: value.updatedAt };
    },
    resumeAfterHumanIntervention: (id: string) => state.resumeAgent(id),
    cancelHumanIntervention: (id: string) => state.cancel(id),
  });
}

function stateAt(status: InterventionStatus, now = 20_000) {
  let clock = now;
  const state = new ExecutionHandoffState<never, "restart_fixture">(() => ++clock, () => "restart-intervention");
  const begun = state.begin({ reason: "restart_fixture", resumePolicy: "never_replay" });
  if (status === "human_active" || status === "verifying" || status === "ready_to_resume") {
    state.claimHuman(begun.id);
  }
  if (status === "verifying" || status === "ready_to_resume") state.markHumanComplete(begun.id);
  if (status === "ready_to_resume") state.markVerified(begun.id);
  return state;
}

function browserFixture() {
  return new BrowserHandoffAdapter({
    takeover: { enabled: true, publicBaseUrl: ORIGIN, ttlMs: 60_000, reconnectIdleMs: 5_000 },
    runtime: { hostExecutable: process.execPath, hostArgs: ["-e", "process.exit(0)"] },
  });
}

function windowFixture() {
  return new WindowHandoffAdapter({
    takeover: { enabled: true, publicBaseUrl: ORIGIN, ttlMs: 60_000, reconnectIdleMs: 5_000 },
    runtime: { hostExecutable: process.execPath, hostArgs: ["-e", "process.exit(0)"] },
  });
}

type BrowserOrWindow = BrowserHandoffAdapter | WindowHandoffAdapter;

async function claimEphemeralGeneration(adapter: BrowserOrWindow, locator: string, principal: string, client: string) {
  const id = new URL(locator).pathname.split("/").at(-1)!;
  const response = await adapter.handle(new Request(
    `${ORIGIN}/takeover/api/webrtc-prepare-claim/${id}`,
    { method: "POST", headers: { origin: ORIGIN, "x-takeover-client": client } },
  ), principal);
  assert.equal(response.status, 200);
  const body = await response.json() as {
    capability: string;
    reconnectHandle: string;
    clientGeneration: number;
  };
  assert.ok(body.capability.length >= 16);
  assert.ok(body.reconnectHandle.length >= 16);
  assert.ok(Number.isSafeInteger(body.clientGeneration) && body.clientGeneration > 0);
  return { id, ...body };
}

async function assertStaleWebRtcGenerationRejected(
  restarted: BrowserOrWindow,
  stale: { id: string; capability: string; reconnectHandle: string; clientGeneration: number },
  principal: string,
  client: string,
) {
  assert.ok(stale.clientGeneration > 0, "pre-crash generation existed only in process memory");
  const oldPage = await restarted.handle(new Request(`${ORIGIN}/takeover/${stale.id}`), principal);
  assert.equal(oldPage.status, 404);
  const staleSuspend = await restarted.handle(new Request(`${ORIGIN}/takeover/api/webrtc-suspend/${stale.id}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "x-takeover-client": client,
      "x-mcp-takeover-capability": stale.capability,
    },
  }), principal);
  assert.equal(staleSuspend.status, 404);
  const staleReconnect = await restarted.handle(new Request(`${ORIGIN}/takeover/api/webrtc-prepare-reconnect/${stale.id}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "x-takeover-client": client,
      "x-mcp-takeover-reconnect": stale.reconnectHandle,
    },
  }), principal);
  assert.equal(staleReconnect.status, 404);
}

function terminalFixture(sessionGeneration: number) {
  return new TerminalHandoffAdapter({
    binding: {
      sessionId: "restart-terminal-session",
      sessionGeneration,
      principalBinding: TERMINAL_PRINCIPAL,
    },
    takeover: { enabled: true, publicBaseUrl: `${ORIGIN}/`, ttlMs: 60_000, env: {} },
  });
}

function terminalRequest(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("origin", ORIGIN);
  headers.set("x-terminal-client", TERMINAL_CLIENT);
  return new Request(new URL(path, `${ORIGIN}/`), { ...init, headers });
}

async function waitFor(predicate: () => boolean, timeoutMs = 7_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("restart conformance timeout");
}

async function connectTerminal(
  adapter: TerminalHandoffAdapter,
  locator: string,
  awaiting: TerminalHandoffInterventionRef,
): Promise<{ client: RTCPeerConnection; channel: RTCDataChannel }> {
  const id = new URL(locator).pathname.split("/").at(-1)!;
  const prep = await adapter.handle(terminalRequest(`/takeover/terminal/api/prepare/${id}`, { method: "POST" }), TERMINAL_PRINCIPAL);
  assert.equal(prep.status, 200);
  const prepared = await prep.json() as { capability: string; webrtcIce: { iceServers: RTCIceServer[] } };
  const client = new RTCPeerConnection({ iceServers: prepared.webrtcIce.iceServers, maxMessageSize: 8 * 1024 });
  const channel = client.createDataChannel("terminal-control", { ordered: true });
  const offer = await client.createOffer();
  await client.setLocalDescription(offer);
  assert.ok(client.localDescription?.sdp);
  const connected = await adapter.handle(terminalRequest(`/takeover/terminal/api/connect/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-terminal-capability": prepared.capability },
    body: JSON.stringify({ type: "offer", sdp: client.localDescription.sdp }),
  }), TERMINAL_PRINCIPAL);
  assert.equal(connected.status, 200);
  const answer = await connected.json() as { webrtc: { type: "answer"; sdp: string } };
  await client.setRemoteDescription(answer.webrtc);
  await waitFor(() => channel.readyState === "open" && adapter.transportStatus(awaiting).transportReady);
  return { client, channel };
}

test("restart recovery is hint-only across every persisted lifecycle phase", () => {
  const statuses: InterventionStatus[] = ["awaiting_human", "human_active", "verifying", "ready_to_resume"];
  for (const status of statuses) {
    const store = new MemoryCheckpointStore();
    const before = stateAt(status);
    const runtime = new ExecutionHandoffRuntime(stateAdapter(before), {
      checkpointStore: store,
      checkpointTtlMs: 60_000,
      now: () => 30_000,
    });
    runtime.checkpoint(PRINCIPAL, ACTION_DIGEST);

    const raw = JSON.stringify(store.value);
    assert.doesNotMatch(raw, /capability|reconnect|requestState|clientGeneration|sessionId|windowId|processId|sdp|candidate|pty|password|token/i);

    // Process restart: all ephemeral state is gone. Only the durable checkpoint store survives.
    const restartedState = new ExecutionHandoffState<never, "restart_fixture">(() => 40_000, () => "fresh-intervention");
    const restarted = new ExecutionHandoffRuntime(stateAdapter(restartedState), {
      checkpointStore: store,
      now: () => 40_000,
    });
    assert.equal(restartedState.getActive(), undefined);
    const authorityBeforeRecovery = restartedState.getAuthority();
    const recovered = restarted.recover(PRINCIPAL);
    assert.equal(recovered?.status, status);
    assert.equal(recovered?.recovery, "reissue_and_revalidate");
    assert.equal(recovered?.actionDigest, ACTION_DIGEST);
    assert.equal(restartedState.getActive(), undefined, `${status} must not recreate an intervention`);
    assert.equal(restartedState.getAuthority(), authorityBeforeRecovery, `${status} recovery must not mutate authority`);
  }
});

test("checkpoint corruption expiry mismatch and interrupted write all fail closed", () => {
  const base: HandoffCheckpoint = {
    version: 1,
    adapterKind: "restart.fixture",
    interventionId: "restart-intervention",
    status: "human_active",
    epoch: 7,
    resumePolicy: "never_replay",
    principalBinding: PRINCIPAL,
    actionDigest: ACTION_DIGEST,
    updatedAt: 20_000,
    expiresAt: 50_000,
  };

  const tampered = new MemoryCheckpointStore();
  tampered.value = { ...base, payload: "must-not-be-accepted" };
  assert.throws(
    () => new ExecutionHandoffRuntime(stateAdapter(new ExecutionHandoffState()), { checkpointStore: tampered, now: () => 30_000 }).recover(PRINCIPAL),
    (error: unknown) => error instanceof HandoffCheckpointError && error.code === "CHECKPOINT_INVALID",
  );

  const expired = new MemoryCheckpointStore();
  expired.value = { ...base, expiresAt: 29_999 };
  assert.throws(
    () => new ExecutionHandoffRuntime(stateAdapter(new ExecutionHandoffState()), { checkpointStore: expired, now: () => 30_000 }).recover(PRINCIPAL),
    (error: unknown) => error instanceof HandoffCheckpointError && error.code === "CHECKPOINT_EXPIRED",
  );

  const mismatch = new MemoryCheckpointStore();
  mismatch.value = base;
  const mismatchRuntime = new ExecutionHandoffRuntime(stateAdapter(new ExecutionHandoffState()), { checkpointStore: mismatch, now: () => 30_000 });
  assert.equal(mismatchRuntime.recover("different-principal-binding-123456"), undefined);
  const otherAdapter = defineExecutionAdapter("other.fixture", stateAdapter(new ExecutionHandoffState()).control);
  assert.equal(new ExecutionHandoffRuntime(otherAdapter, { checkpointStore: mismatch, now: () => 30_000 }).recover(PRINCIPAL), undefined);

  const humanState = stateAt("human_active");
  const failing = new ExecutionHandoffRuntime(stateAdapter(humanState), {
    checkpointStore: new FailingCheckpointStore(),
    checkpointTtlMs: 60_000,
    now: () => 30_000,
  });
  assert.equal(humanState.getAuthority(), "human");
  assert.throws(() => failing.checkpoint(PRINCIPAL, ACTION_DIGEST), /checkpoint write interrupted/);
  assert.equal(humanState.getActive(), undefined, "interrupted persistence cancels the active intervention");
  assert.equal(humanState.getAuthority(), "agent", "same-process cancellation advances epoch before Agent authority returns");
});

test("Browser and Window restart reject stale locator capability generation and reconnect handle", async () => {
  const cases = [
    {
      name: "browser",
      make: browserFixture,
      start: (adapter: BrowserHandoffAdapter) => adapter.start({
        intervention: { id: "restart-browser", epoch: 3 },
        principalBinding: PRINCIPAL,
        target: { processId: 4242, windowId: 7331 },
        inputPolicy: ALL_INPUT,
      }),
    },
    {
      name: "window",
      make: windowFixture,
      start: (adapter: WindowHandoffAdapter) => adapter.start({
        intervention: { id: "restart-window", epoch: 4 },
        principalBinding: PRINCIPAL,
        target: { processId: 4242, windowId: 7331 },
        inputPolicy: POINTER_ONLY,
      }),
    },
  ] as const;

  for (const entry of cases) {
    const oldAdapter = entry.make() as BrowserHandoffAdapter & WindowHandoffAdapter;
    const locator = entry.start(oldAdapter as never);
    const client = `${entry.name}-restart-client-1234567890`;
    const stale = await claimEphemeralGeneration(oldAdapter, locator, PRINCIPAL, client);

    // Simulated process restart: construct a fresh first-class facade; no broker/runtime state is copied.
    const restarted = entry.make() as BrowserHandoffAdapter & WindowHandoffAdapter;
    assert.equal(restarted.ownsPath(new URL(locator).pathname), false);
    await assertStaleWebRtcGenerationRejected(restarted, stale, PRINCIPAL, client);
    await oldAdapter.revokeForIntervention(entry.name === "browser" ? "restart-browser" : "restart-window");
  }
});

test("Terminal Human-active restart does not replay queued Human input or restore old transport authority", async () => {
  const oldAdapter = terminalFixture(9);
  const { intervention: awaiting, locator } = oldAdapter.begin();
  const { client, channel } = await connectTerminal(oldAdapter, locator, awaiting);
  try {
    const human = oldAdapter.claimHumanAfterAgentDrain(awaiting);
    assert.equal(oldAdapter.status().authority, "human");
    const queued = Buffer.from("echo never-replay\n");
    channel.send(JSON.stringify({ kind: "input", dataBase64: queued.toString("base64") }));
    await waitFor(() => oldAdapter.transportStatus(human).queuedEvents > 0);

    // Consumer reconstructs a fresh PTY/session generation after restart. No old adapter state is copied.
    const restarted = terminalFixture(10);
    assert.equal(restarted.status().authority, "agent");
    assert.equal(restarted.status().interventionStatus, null);
    assert.equal(restarted.status().transport, null);
    assert.throws(
      () => restarted.nextHumanEvent(human),
      (error: unknown) => error instanceof TerminalHandoffAdapterError
        && error.code === "TERMINAL_HANDOFF_INTERVENTION_STALE",
    );
    const stalePage = await restarted.handle(new Request(locator), TERMINAL_PRINCIPAL);
    assert.equal(stalePage.status, 404);
    assert.doesNotMatch(JSON.stringify(restarted.operatorDiagnosticsSnapshot()), /never-replay|restart-terminal-session|sessionGeneration/i);
  } finally {
    await client.close().catch(() => undefined);
    await oldAdapter.revokeTransport();
  }
});

test("Terminal PTY exit during Human authority fences both sides and never synthesizes replacement Agent authority", async () => {
  const adapter = terminalFixture(11);
  const { intervention: awaiting, locator } = adapter.begin();
  const { client } = await connectTerminal(adapter, locator, awaiting);
  try {
    const human = adapter.claimHumanAfterAgentDrain(awaiting);
    assert.equal(human.status, "human_active");
    assert.equal(adapter.status().authority, "human");
    const exited = await adapter.noteSessionExit();
    assert.equal(exited.sessionAlive, false);
    assert.equal(exited.authority, "none");
    assert.equal(exited.interventionStatus, "verifying");
    assert.equal(exited.transport, null);
    assert.throws(() => adapter.assertAgentInput());
    assert.throws(() => adapter.assertHumanInput(human));
  } finally {
    await client.close().catch(() => undefined);
    await adapter.revokeTransport();
  }
});
