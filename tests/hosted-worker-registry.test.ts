import assert from "node:assert/strict";
import test from "node:test";
import {
  HostedWorkerRegistry,
  HostedWorkerRegistryError,
  type HostedWorkerRouteLease
} from "../src/core/index.js";

const PRINCIPAL_A = "a".repeat(64);
const PRINCIPAL_B = "b".repeat(64);
const CHANNEL_A = "c".repeat(64);
const CHANNEL_B = "d".repeat(64);

function code(expected: HostedWorkerRegistryError["code"]) {
  return (error: unknown) => error instanceof HostedWorkerRegistryError && error.code === expected;
}

test("hosted worker registration is authenticated-channel bound, principal pinned, and idempotent only for the same channel", () => {
  const registry = new HostedWorkerRegistry(() => 1_000);
  const first = registry.register({
    workerId: "worker-a",
    principalBinding: PRINCIPAL_A,
    channelBinding: CHANNEL_A
  });
  assert.deepEqual(first, {
    workerId: "worker-a",
    principalBinding: PRINCIPAL_A,
    generation: 1,
    registeredAt: 1_000
  });
  assert.deepEqual(registry.register({
    workerId: "worker-a",
    principalBinding: PRINCIPAL_A,
    channelBinding: CHANNEL_A
  }), first);
  assert.throws(() => registry.register({
    workerId: "worker-a",
    principalBinding: PRINCIPAL_A,
    channelBinding: CHANNEL_B
  }), code("HOSTED_WORKER_ALREADY_CONNECTED"));
  assert.throws(() => registry.register({
    workerId: "worker-a",
    principalBinding: PRINCIPAL_B,
    channelBinding: CHANNEL_B
  }), code("HOSTED_WORKER_IDENTITY_CONFLICT"));
});

test("hosted worker reconnect increments generation and stale disconnect cannot fence the successor", () => {
  let now = 1_000;
  const registry = new HostedWorkerRegistry(() => now);
  const first = registry.register({
    workerId: "worker-a",
    principalBinding: PRINCIPAL_A,
    channelBinding: CHANNEL_A
  });
  assert.deepEqual(registry.disconnect("worker-a", first.generation, CHANNEL_A), []);

  now = 2_000;
  const second = registry.register({
    workerId: "worker-a",
    principalBinding: PRINCIPAL_A,
    channelBinding: CHANNEL_B
  });
  assert.equal(second.generation, 2);
  assert.equal(second.registeredAt, 2_000);
  assert.throws(
    () => registry.disconnect("worker-a", first.generation, CHANNEL_A),
    code("HOSTED_WORKER_STALE_GENERATION")
  );
  assert.deepEqual(registry.get("worker-a"), second);
});

test("intervention route binds principal, epoch, worker identity, and current worker generation", () => {
  const registry = new HostedWorkerRegistry();
  const worker = registry.register({
    workerId: "worker-a",
    principalBinding: PRINCIPAL_A,
    channelBinding: CHANNEL_A
  });
  const route = registry.bindIntervention({
    interventionId: "intervention-1",
    epoch: 7,
    principalBinding: PRINCIPAL_A,
    workerId: worker.workerId,
    workerGeneration: worker.generation
  });
  registry.assertCurrent(route);
  assert.throws(() => registry.bindIntervention({
    interventionId: "intervention-2",
    epoch: 7,
    principalBinding: PRINCIPAL_B,
    workerId: worker.workerId,
    workerGeneration: worker.generation
  }), code("HOSTED_WORKER_PRINCIPAL_MISMATCH"));
  assert.throws(() => registry.bindIntervention({
    interventionId: "intervention-2",
    epoch: 7,
    principalBinding: PRINCIPAL_A,
    workerId: worker.workerId,
    workerGeneration: worker.generation + 1
  }), code("HOSTED_WORKER_STALE_GENERATION"));
});

test("worker disconnect immediately revokes active routes and same worker may explicitly rebind at the same epoch after reconnect", () => {
  const registry = new HostedWorkerRegistry();
  const first = registry.register({
    workerId: "worker-a",
    principalBinding: PRINCIPAL_A,
    channelBinding: CHANNEL_A
  });
  const firstRoute = registry.bindIntervention({
    interventionId: "intervention-1",
    epoch: 9,
    principalBinding: PRINCIPAL_A,
    workerId: "worker-a",
    workerGeneration: first.generation
  });
  assert.deepEqual(registry.disconnect("worker-a", first.generation, CHANNEL_A), [firstRoute]);
  assert.throws(() => registry.assertCurrent(firstRoute), code("HOSTED_WORKER_STALE_GENERATION"));

  const second = registry.register({
    workerId: "worker-a",
    principalBinding: PRINCIPAL_A,
    channelBinding: CHANNEL_B
  });
  const rebound = registry.bindIntervention({
    ...firstRoute,
    workerGeneration: second.generation
  });
  assert.equal(rebound.epoch, firstRoute.epoch);
  assert.equal(rebound.workerGeneration, 2);
  registry.assertCurrent(rebound);
});

test("an intervention cannot silently move to another worker even after its epoch advances", () => {
  const registry = new HostedWorkerRegistry();
  const a = registry.register({
    workerId: "worker-a",
    principalBinding: PRINCIPAL_A,
    channelBinding: CHANNEL_A
  });
  const b = registry.register({
    workerId: "worker-b",
    principalBinding: PRINCIPAL_A,
    channelBinding: CHANNEL_B
  });
  const route = registry.bindIntervention({
    interventionId: "intervention-1",
    epoch: 12,
    principalBinding: PRINCIPAL_A,
    workerId: a.workerId,
    workerGeneration: a.generation
  });
  registry.disconnect(a.workerId, a.generation, CHANNEL_A);
  assert.throws(() => registry.bindIntervention({
    ...route,
    workerId: b.workerId,
    workerGeneration: b.generation
  }), code("HOSTED_WORKER_ROUTE_CONFLICT"));

  assert.throws(() => registry.bindIntervention({
    ...route,
    epoch: 13,
    workerId: b.workerId,
    workerGeneration: b.generation
  }), code("HOSTED_WORKER_ROUTE_CONFLICT"));
});

test("route release is generation fenced and never revives stale authority", () => {
  const registry = new HostedWorkerRegistry();
  const worker = registry.register({
    workerId: "worker-a",
    principalBinding: PRINCIPAL_A,
    channelBinding: CHANNEL_A
  });
  const route = registry.bindIntervention({
    interventionId: "intervention-1",
    epoch: 3,
    principalBinding: PRINCIPAL_A,
    workerId: worker.workerId,
    workerGeneration: worker.generation
  });
  const stale: HostedWorkerRouteLease = { ...route, workerGeneration: route.workerGeneration + 1 };
  assert.throws(() => registry.releaseIntervention(stale), code("HOSTED_WORKER_STALE_GENERATION"));
  registry.assertCurrent(route);
  registry.releaseIntervention(route);
  assert.throws(() => registry.assertCurrent(route), code("HOSTED_WORKER_STALE_GENERATION"));
  assert.throws(() => registry.releaseIntervention(route), code("HOSTED_WORKER_ROUTE_NOT_FOUND"));
});

test("hosted worker contract rejects content-bearing or credential-shaped extra fields", () => {
  const registry = new HostedWorkerRegistry();
  assert.throws(() => registry.register({
    workerId: "worker-a",
    principalBinding: PRINCIPAL_A,
    channelBinding: CHANNEL_A,
    token: "must-not-enter-registry"
  } as never), code("HOSTED_WORKER_INVALID"));

  const worker = registry.register({
    workerId: "worker-a",
    principalBinding: PRINCIPAL_A,
    channelBinding: CHANNEL_A
  });
  assert.throws(() => registry.bindIntervention({
    interventionId: "intervention-1",
    epoch: 1,
    principalBinding: PRINCIPAL_A,
    workerId: worker.workerId,
    workerGeneration: worker.generation,
    frame: "must-not-enter-route"
  } as never), code("HOSTED_WORKER_INVALID"));
});
