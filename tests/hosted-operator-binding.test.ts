import assert from "node:assert/strict";
import test from "node:test";
import {
  HostedOperatorBindingError,
  HostedWorkerRegistry,
  assertHostedOperatorBindingCurrent,
  bindHostedOperatorSession,
  parseHostedOperatorSessionReference,
  type HostedOperatorSessionReference
} from "../src/core/index.js";

const PRINCIPAL = "a".repeat(64);
const CHANNEL_A = "b".repeat(64);
const CHANNEL_B = "c".repeat(64);

function operator(overrides: Partial<HostedOperatorSessionReference> = {}): HostedOperatorSessionReference {
  return {
    sessionId: "operator-session-1",
    interventionId: "intervention-1",
    epoch: 4,
    principalBinding: PRINCIPAL,
    expiresAt: 10_000,
    viewerGeneration: 1,
    ...overrides
  };
}

function errorCode(expected: HostedOperatorBindingError["code"]) {
  return (error: unknown) => error instanceof HostedOperatorBindingError && error.code === expected;
}

test("hosted operator binding composes existing operator and worker authority without creating another lifecycle", () => {
  const registry = new HostedWorkerRegistry();
  const worker = registry.register({
    workerId: "worker-a",
    principalBinding: PRINCIPAL,
    channelBinding: CHANNEL_A
  });
  const route = registry.bindIntervention({
    interventionId: "intervention-1",
    epoch: 4,
    principalBinding: PRINCIPAL,
    workerId: worker.workerId,
    workerGeneration: worker.generation
  });
  const current = operator();
  const binding = bindHostedOperatorSession(current, route, registry, 1_000);

  assert.deepEqual(binding.operator, current);
  assert.deepEqual(binding.worker, route);
  assertHostedOperatorBindingCurrent(binding, current, registry, 1_000);
});

test("operator TTL is independent from worker connection lifetime and never extends on worker reconnect", () => {
  const registry = new HostedWorkerRegistry();
  const firstWorker = registry.register({
    workerId: "worker-a",
    principalBinding: PRINCIPAL,
    channelBinding: CHANNEL_A
  });
  const firstRoute = registry.bindIntervention({
    interventionId: "intervention-1",
    epoch: 4,
    principalBinding: PRINCIPAL,
    workerId: "worker-a",
    workerGeneration: firstWorker.generation
  });
  const current = operator({ expiresAt: 5_000 });
  const firstBinding = bindHostedOperatorSession(current, firstRoute, registry, 1_000);

  registry.disconnect("worker-a", firstWorker.generation, CHANNEL_A);
  assert.throws(
    () => assertHostedOperatorBindingCurrent(firstBinding, current, registry, 2_000),
    /no longer current/
  );

  const secondWorker = registry.register({
    workerId: "worker-a",
    principalBinding: PRINCIPAL,
    channelBinding: CHANNEL_B
  });
  const secondRoute = registry.bindIntervention({
    interventionId: "intervention-1",
    epoch: 4,
    principalBinding: PRINCIPAL,
    workerId: "worker-a",
    workerGeneration: secondWorker.generation
  });
  const rebound = bindHostedOperatorSession(current, secondRoute, registry, 2_000);
  assert.equal(rebound.operator.expiresAt, 5_000);
  assert.equal(rebound.operator.viewerGeneration, 1);
  assert.equal(rebound.worker.workerGeneration, 2);
  assert.throws(
    () => assertHostedOperatorBindingCurrent(rebound, current, registry, 5_000),
    errorCode("HOSTED_OPERATOR_SESSION_EXPIRED")
  );
});

test("viewer generation rotates independently and stale viewer binding fails closed", () => {
  const registry = new HostedWorkerRegistry();
  const worker = registry.register({
    workerId: "worker-a",
    principalBinding: PRINCIPAL,
    channelBinding: CHANNEL_A
  });
  const route = registry.bindIntervention({
    interventionId: "intervention-1",
    epoch: 4,
    principalBinding: PRINCIPAL,
    workerId: "worker-a",
    workerGeneration: worker.generation
  });
  const first = operator({ viewerGeneration: 1 });
  const binding = bindHostedOperatorSession(first, route, registry, 1_000);
  const reconnectedViewer = operator({ viewerGeneration: 2 });

  assert.throws(
    () => assertHostedOperatorBindingCurrent(binding, reconnectedViewer, registry, 2_000),
    errorCode("HOSTED_OPERATOR_VIEWER_STALE")
  );

  const fresh = bindHostedOperatorSession(reconnectedViewer, route, registry, 2_000);
  assertHostedOperatorBindingCurrent(fresh, reconnectedViewer, registry, 2_000);
  assert.equal(fresh.worker.workerGeneration, 1);
});

test("operator session and worker route must match principal intervention and epoch exactly", () => {
  const registry = new HostedWorkerRegistry();
  const worker = registry.register({
    workerId: "worker-a",
    principalBinding: PRINCIPAL,
    channelBinding: CHANNEL_A
  });
  const route = registry.bindIntervention({
    interventionId: "intervention-1",
    epoch: 4,
    principalBinding: PRINCIPAL,
    workerId: "worker-a",
    workerGeneration: worker.generation
  });

  for (const candidate of [
    operator({ interventionId: "intervention-2" }),
    operator({ epoch: 5 }),
    operator({ principalBinding: "d".repeat(64) })
  ]) {
    assert.throws(
      () => bindHostedOperatorSession(candidate, route, registry, 1_000),
      errorCode("HOSTED_OPERATOR_SESSION_MISMATCH")
    );
  }
});

test("hosted operator session reference is closed-world and rejects content credential and route fields", () => {
  for (const field of [
    "frame", "humanInput", "credential", "token", "cookie", "targetIdentity",
    "workerId", "workerGeneration", "channelBinding", "provider"
  ]) {
    assert.throws(
      () => parseHostedOperatorSessionReference({ ...operator(), [field]: "forbidden" }),
      errorCode("HOSTED_OPERATOR_SESSION_INVALID")
    );
  }
});

test("worker route rotation cannot revive an expired or stale viewer session", () => {
  const registry = new HostedWorkerRegistry();
  const first = registry.register({
    workerId: "worker-a",
    principalBinding: PRINCIPAL,
    channelBinding: CHANNEL_A
  });
  const firstRoute = registry.bindIntervention({
    interventionId: "intervention-1",
    epoch: 4,
    principalBinding: PRINCIPAL,
    workerId: "worker-a",
    workerGeneration: first.generation
  });
  const expiredSoon = operator({ expiresAt: 2_000 });
  bindHostedOperatorSession(expiredSoon, firstRoute, registry, 1_000);
  registry.disconnect("worker-a", first.generation, CHANNEL_A);

  const second = registry.register({
    workerId: "worker-a",
    principalBinding: PRINCIPAL,
    channelBinding: CHANNEL_B
  });
  const secondRoute = registry.bindIntervention({
    interventionId: "intervention-1",
    epoch: 4,
    principalBinding: PRINCIPAL,
    workerId: "worker-a",
    workerGeneration: second.generation
  });
  assert.throws(
    () => bindHostedOperatorSession(expiredSoon, secondRoute, registry, 2_000),
    errorCode("HOSTED_OPERATOR_SESSION_EXPIRED")
  );

  const staleViewer = operator({ expiresAt: 5_000, viewerGeneration: 1 });
  const freshBinding = bindHostedOperatorSession(
    operator({ expiresAt: 5_000, viewerGeneration: 2 }),
    secondRoute,
    registry,
    2_000
  );
  assert.throws(
    () => assertHostedOperatorBindingCurrent(freshBinding, staleViewer, registry, 2_500),
    errorCode("HOSTED_OPERATOR_VIEWER_STALE")
  );
});
