import assert from "node:assert/strict";
import test from "node:test";
import {
  ExperimentalTerminalPtyAuthority,
  ExperimentalTerminalPtyError,
  type ExperimentalTerminalPtyBinding,
} from "../src/experimental/terminal-pty.js";

const BINDING: ExperimentalTerminalPtyBinding = {
  sessionId: "pty-session-a",
  sessionGeneration: 7,
  principalBinding: "principal-binding-a",
};

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fixture() {
  let id = 0;
  const agentDrain = deferred();
  const humanDrain = deferred();
  const gate = new ExperimentalTerminalPtyAuthority(
    BINDING,
    {
      drainAgentWrites: () => agentDrain.promise,
      drainHumanWrites: () => humanDrain.promise,
    },
    () => 1_000,
    () => `intervention-${++id}`,
  );
  return { gate, agentDrain, humanDrain };
}

function expectCode(code: ExperimentalTerminalPtyError["code"]) {
  return (error: unknown) => error instanceof ExperimentalTerminalPtyError && error.code === code;
}

test("Agent is fenced before pre-Handoff writes drain and Human cannot claim early", async () => {
  const { gate, agentDrain } = fixture();
  gate.assertAgentInput(BINDING);
  gate.assertAgentObservation(BINDING);

  const pending = gate.beginHuman(BINDING);
  assert.equal(gate.getStatus().authority, "none");
  assert.throws(() => gate.assertAgentInput(BINDING));
  assert.throws(() => gate.assertAgentObservation(BINDING));

  agentDrain.resolve();
  const human = await pending;
  assert.equal(human.status, "human_active");
  assert.equal(gate.getStatus().authority, "human");
});

test("Human input, observation and resize require the exact PTY session and intervention epoch", async () => {
  const { gate, agentDrain } = fixture();
  const pending = gate.beginHuman(BINDING);
  agentDrain.resolve();
  const human = await pending;

  gate.assertHumanInput(BINDING, human.id, human.epoch);
  gate.assertHumanObservation(BINDING, human.id, human.epoch);
  gate.assertHumanResize(BINDING, human.id, human.epoch);
  assert.throws(
    () => gate.assertHumanInput({ ...BINDING, sessionGeneration: 8 }, human.id, human.epoch),
    expectCode("TERMINAL_SESSION_MISMATCH"),
  );
  assert.throws(
    () => gate.assertHumanInput(BINDING, human.id, human.epoch + 1),
    expectCode("TERMINAL_INTERVENTION_STALE"),
  );
});

test("Done fences Human immediately, drains admitted Human writes, then requires explicit verification/resume", async () => {
  const { gate, agentDrain, humanDrain } = fixture();
  const pending = gate.beginHuman(BINDING);
  agentDrain.resolve();
  const human = await pending;

  const done = gate.markHumanDone(BINDING, human.id, human.epoch);
  const verifying = gate.getStatus();
  assert.equal(verifying.authority, "none");
  assert.equal(verifying.interventionStatus, "verifying");
  assert.throws(() => gate.assertHumanInput(BINDING, human.id, human.epoch));
  assert.throws(() => gate.assertAgentObservation(BINDING));

  humanDrain.resolve();
  const drained = await done;
  assert.equal(drained.status, "verifying");
  const ready = gate.reportVerification(BINDING, drained.id, drained.epoch, true);
  assert.equal(ready.status, "ready_to_resume");
  assert.equal(gate.getStatus().authority, "none");

  const resume = gate.resumeAgent(BINDING, ready.id, ready.epoch);
  assert.equal(resume.resumePolicy, "never_replay");
  assert.equal(resume.agentStateSynchronizationRequired, true);
  assert.throws(() => gate.assertAgentObservation(BINDING), expectCode("TERMINAL_AGENT_STATE_SYNC_REQUIRED"));
  assert.throws(() => gate.assertAgentInput(BINDING), expectCode("TERMINAL_AGENT_STATE_SYNC_REQUIRED"));
  gate.acknowledgeAgentStateSynchronization(BINDING);
  gate.assertAgentObservation(BINDING);
  gate.assertAgentInput(BINDING);
});

test("Human disconnect is not Done and never restores Agent authority", async () => {
  const { gate, agentDrain } = fixture();
  const pending = gate.beginHuman(BINDING);
  agentDrain.resolve();
  const human = await pending;

  const disconnected = gate.noteHumanDisconnect(BINDING, human.id, human.epoch);
  assert.equal(disconnected.authority, "human");
  assert.equal(disconnected.interventionStatus, "human_active");
  assert.equal(disconnected.humanDisconnected, true);
  assert.throws(() => gate.assertAgentInput(BINDING));
});

test("PTY exit under Human authority transitions to verifying and never revives the closed session", async () => {
  const { gate, agentDrain, humanDrain } = fixture();
  const pending = gate.beginHuman(BINDING);
  agentDrain.resolve();
  const human = await pending;

  const exited = gate.noteSessionExit(BINDING);
  assert.equal(exited.sessionAlive, false);
  assert.equal(exited.authority, "none");
  assert.equal(exited.interventionStatus, "verifying");
  assert.throws(() => gate.assertHumanInput(BINDING, human.id, human.epoch), expectCode("TERMINAL_SESSION_CLOSED"));

  // No Human write drain is needed for the exit transition itself; verification is content-free.
  humanDrain.resolve();
  const active = gate.getStatus();
  const ready = gate.reportVerification(BINDING, human.id, active.interventionEpoch!, true);
  const resumed = gate.resumeAgent(BINDING, ready.id, ready.epoch);
  assert.equal(resumed.sessionAlive, false);
  assert.equal(gate.getStatus().authority, "none");
  assert.throws(() => gate.assertAgentObservation(BINDING), expectCode("TERMINAL_SESSION_CLOSED"));
  assert.throws(() => gate.acknowledgeAgentStateSynchronization(BINDING), expectCode("TERMINAL_SESSION_CLOSED"));
});

test("status is privacy bounded and carries no PTY content or private session/principal identity", async () => {
  const { gate, agentDrain } = fixture();
  const pending = gate.beginHuman(BINDING);
  agentDrain.resolve();
  await pending;
  const encoded = JSON.stringify(gate.getStatus());
  assert.doesNotMatch(encoded, /pty-session-a|principal-binding-a|password|token|secret/i);
  assert.deepEqual(Object.keys(gate.getStatus()).sort(), [
    "agentStateSynchronizationRequired",
    "authority",
    "humanDisconnected",
    "interventionEpoch",
    "interventionStatus",
    "sessionAlive",
    "sessionGeneration",
  ]);
});

test("staged drain protocol fences before external drain and refuses verification until Human drain is confirmed", () => {
  const { gate } = fixture();
  const fenced = gate.beginFence(BINDING);
  assert.equal(gate.getStatus().authority, "none");
  assert.throws(() => gate.assertAgentInput(BINDING));
  const human = gate.claimHumanAfterAgentDrain(BINDING, fenced.id, fenced.epoch);
  assert.equal(human.status, "human_active");

  const verifying = gate.markHumanDoneFence(BINDING, human.id, human.epoch);
  assert.equal(gate.getStatus().authority, "none");
  assert.throws(
    () => gate.reportVerification(BINDING, verifying.id, verifying.epoch, true),
    expectCode("TERMINAL_INTERVENTION_STALE"),
  );
  gate.confirmHumanWritesDrained(BINDING, verifying.id, verifying.epoch);
  const ready = gate.reportVerification(BINDING, verifying.id, verifying.epoch, true);
  assert.equal(ready.status, "ready_to_resume");
});
test("PTY exit after Agent fence but before Human claim cancels only the unclaimed intervention", () => {
  const { gate } = fixture();
  const awaiting = gate.beginFence(BINDING);
  assert.equal(awaiting.status, "awaiting_human");
  const closed = gate.noteSessionExit(BINDING);
  assert.equal(closed.sessionAlive, false);
  assert.equal(closed.interventionStatus, null);
  assert.equal(closed.authority, "none");
  assert.throws(
    () => gate.claimHumanAfterAgentDrain(BINDING, awaiting.id, awaiting.epoch),
    expectCode("TERMINAL_SESSION_CLOSED"),
  );
});

test("pre-claim cancellation restores Agent only because Human authority was never granted", () => {
  const { gate } = fixture();
  const awaiting = gate.beginFence(BINDING);
  assert.equal(gate.getStatus().authority, "none");
  const restored = gate.cancelBeforeHuman(BINDING, awaiting.id, awaiting.epoch);
  assert.equal(restored.authority, "agent");
  assert.equal(restored.interventionStatus, null);
  gate.assertAgentInput(BINDING);

  const second = gate.beginFence(BINDING);
  const human = gate.claimHumanAfterAgentDrain(BINDING, second.id, second.epoch);
  assert.throws(
    () => gate.cancelBeforeHuman(BINDING, human.id, human.epoch),
    expectCode("TERMINAL_INTERVENTION_STALE"),
  );
});
