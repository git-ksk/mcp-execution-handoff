import assert from "node:assert/strict";
import test from "node:test";
import {
  EXECUTION_AUDIT_SCHEMA_VERSION,
  MemoryExecutionAuditSink,
  parseExecutionAuditEvent,
  type ExecutionAuditEvent
} from "../src/core/index.js";

function checkpointWritten(index = 0): ExecutionAuditEvent {
  return {
    version: EXECUTION_AUDIT_SCHEMA_VERSION,
    type: "checkpoint_written",
    adapterKind: "browser.test",
    timestamp: 10_000 + index,
    interventionId: `intervention-${index}`,
    epoch: index,
    principalBinding: "principal-binding-a-1234567890",
    actionDigest: "digest-value-1234567890"
  };
}

test("stable audit v1 parser accepts only bounded enumerated control-plane fields", () => {
  assert.deepEqual(parseExecutionAuditEvent(checkpointWritten()), checkpointWritten());
  assert.deepEqual(parseExecutionAuditEvent({
    version: 1,
    type: "checkpoint_cleared",
    adapterKind: "terminal.test",
    timestamp: 12_000
  }), {
    version: 1,
    type: "checkpoint_cleared",
    adapterKind: "terminal.test",
    timestamp: 12_000
  });

  for (const field of [
    "args", "rawArgs", "humanInput", "ptyContent", "browserContent", "framebuffer", "media",
    "credential", "cookie", "token", "otp", "challengeAnswer", "payment", "approvalReceipt",
    "capability", "requestState", "clientGeneration", "reconnectHandle", "candidate", "ip", "sdp",
    "message", "reason"
  ]) {
    assert.throws(() => parseExecutionAuditEvent({ ...checkpointWritten(), [field]: "secret" }), /Invalid execution audit event/);
  }
});

test("stable audit v1 bounds identifiers, timestamps, epochs, and schema version", () => {
  const base = checkpointWritten();
  assert.throws(() => parseExecutionAuditEvent({ ...base, version: 2 }), /Invalid/);
  assert.throws(() => parseExecutionAuditEvent({ ...base, adapterKind: "a".repeat(81) }), /Invalid/);
  assert.throws(() => parseExecutionAuditEvent({ ...base, interventionId: "i".repeat(161) }), /Invalid/);
  assert.throws(() => parseExecutionAuditEvent({ ...base, principalBinding: "short" }), /Invalid/);
  assert.throws(() => parseExecutionAuditEvent({ ...base, actionDigest: "d".repeat(161) }), /Invalid/);
  assert.throws(() => parseExecutionAuditEvent({ ...base, timestamp: -1 }), /Invalid/);
  assert.throws(() => parseExecutionAuditEvent({ ...base, epoch: -1 }), /Invalid/);
  assert.throws(() => parseExecutionAuditEvent({ ...base, adapterKind: "browser\nsecret" }), /Invalid/);
});

test("memory audit sink is bounded to the newest 256 validated events and snapshots are isolated", () => {
  const sink = new MemoryExecutionAuditSink();
  for (let index = 0; index < 300; index += 1) sink.record(checkpointWritten(index));
  const snapshot = sink.snapshot();
  assert.equal(snapshot.length, 256);
  assert.equal(snapshot[0]?.epoch, 44);
  assert.equal(snapshot.at(-1)?.epoch, 299);
  snapshot[0]!.adapterKind = "mutated";
  assert.equal(sink.snapshot()[0]?.adapterKind, "browser.test");
});

test("Browser Window and Terminal audit use the same metadata-only contract without target content", () => {
  const sink = new MemoryExecutionAuditSink();
  for (const adapterKind of ["browser.test", "window.test", "terminal.test"]) {
    sink.record({
      version: 1,
      type: "checkpoint_cleared",
      adapterKind,
      timestamp: 20_000
    });
  }
  const encoded = JSON.stringify(sink.snapshot());
  assert.equal(sink.snapshot().length, 3);
  assert.doesNotMatch(encoded, /frame|pty|input|credential|candidate|windowId|processId|content/i);
});
