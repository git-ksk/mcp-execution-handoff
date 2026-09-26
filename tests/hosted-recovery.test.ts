import assert from "node:assert/strict";
import test from "node:test";
import {
  HandoffCheckpointError,
  HostedWorkerRegistry,
  recoverHostedControlPlane,
  type HandoffCheckpoint
} from "../src/core/index.js";

const checkpoint: HandoffCheckpoint = {
  version: 1,
  adapterKind: "window_handoff",
  interventionId: "intervention-1",
  status: "human_active",
  epoch: 9,
  resumePolicy: "revalidate",
  principalBinding: "a".repeat(64),
  actionDigest: "b".repeat(64),
  updatedAt: 1_000,
  expiresAt: 10_000
};

test("hosted recovery projects v0.3 checkpoint into reissue-only orchestration", () => {
  assert.deepEqual(recoverHostedControlPlane(checkpoint, 2_000), {
    version: 1,
    interventionId: "intervention-1",
    epoch: 9,
    principalBinding: "a".repeat(64),
    resumePolicy: "revalidate",
    actionDigest: "b".repeat(64),
    recovery: "reissue_and_revalidate",
    workerRoute: "reconnect_required",
    operatorSession: "reissue_required"
  });
});

test("hosted recovery never reconstructs worker route operator generation or content state", () => {
  const recovered = recoverHostedControlPlane(checkpoint, 2_000);
  const encoded = JSON.stringify(recovered);
  assert.doesNotMatch(
    encoded,
    /workerId|workerGeneration|channelBinding|sessionId|viewerGeneration|locator|capability|frame|humanInput|cookie|credential|targetIdentity/i
  );

  const restartedRegistry = new HostedWorkerRegistry();
  assert.equal(restartedRegistry.get("worker-a"), undefined);
});

test("hosted recovery rejects attempts to persist hosted route or operator session fields", () => {
  for (const extra of [
    { workerId: "worker-a" },
    { workerGeneration: 2 },
    { channelBinding: "c".repeat(64) },
    { sessionId: "operator-session-1" },
    { viewerGeneration: 3 },
    { frame: "forbidden" },
    { humanInput: "forbidden" },
    { credential: "forbidden" }
  ]) {
    assert.throws(
      () => recoverHostedControlPlane({ ...checkpoint, ...extra }, 2_000),
      (error: unknown) => error instanceof HandoffCheckpointError
        && error.code === "CHECKPOINT_INVALID"
    );
  }
});

test("expired hosted checkpoint cannot restore hosted routing or operator session", () => {
  assert.throws(
    () => recoverHostedControlPlane(checkpoint, checkpoint.expiresAt),
    (error: unknown) => error instanceof HandoffCheckpointError
      && error.code === "CHECKPOINT_EXPIRED"
  );
});

test("hosted recovery preserves restrictive resume policy without replaying action content", () => {
  const recovered = recoverHostedControlPlane({
    ...checkpoint,
    resumePolicy: "never_replay",
    actionDigest: undefined
  }, 2_000);
  assert.equal(recovered.resumePolicy, "never_replay");
  assert.equal("actionDigest" in recovered, false);
  assert.equal(recovered.workerRoute, "reconnect_required");
  assert.equal(recovered.operatorSession, "reissue_required");
});
