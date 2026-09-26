import assert from "node:assert/strict";
import test from "node:test";
import {
  HostedLatestFrameBridge,
  HostedWorkerFrameError,
  HostedWorkerFrameIngress,
  HostedWorkerRegistry,
  HostedWorkerRouteGate,
  bindHostedOperatorSession,
  type HostedEphemeralFrame,
  type HostedOperatorSessionReference
} from "../src/core/index.js";

const PRINCIPAL = "a".repeat(64);
const CHANNEL = "b".repeat(64);

function frame(marker: number): HostedEphemeralFrame {
  return {
    data: new Uint8Array([marker]),
    width: 64,
    height: 48,
    mimeType: "image/jpeg"
  };
}

function fixture() {
  const registry = new HostedWorkerRegistry();
  const worker = registry.register({
    workerId: "worker-a",
    principalBinding: PRINCIPAL,
    channelBinding: CHANNEL
  });
  const route = registry.bindIntervention({
    interventionId: "intervention-1",
    epoch: 5,
    principalBinding: PRINCIPAL,
    workerId: worker.workerId,
    workerGeneration: worker.generation
  });
  let operator: HostedOperatorSessionReference = {
    sessionId: "operator-session-1",
    interventionId: route.interventionId,
    epoch: route.epoch,
    principalBinding: PRINCIPAL,
    expiresAt: Date.now() + 60_000,
    viewerGeneration: 1
  };
  const binding = bindHostedOperatorSession(operator, route, registry);
  const delivered: number[] = [];
  const bridge = new HostedLatestFrameBridge({
    binding,
    registry,
    currentOperator: () => operator,
    peer: {
      bufferedAmount: () => 0,
      sendFrame(value) {
        delivered.push(value.data[0]!);
      }
    }
  });
  const ingress = new HostedWorkerFrameIngress(
    binding,
    registry,
    () => operator,
    bridge
  );
  const gate = new HostedWorkerRouteGate();
  gate.applyControl({
    version: 1,
    type: "registered",
    workerGeneration: worker.generation
  });
  gate.applyControl({
    version: 1,
    type: "bind",
    interventionId: route.interventionId,
    epoch: route.epoch,
    workerGeneration: route.workerGeneration
  });
  return {
    registry,
    route,
    gate,
    ingress,
    delivered,
    operator: () => operator,
    setOperator(next: HostedOperatorSessionReference) { operator = next; }
  };
}

test("worker-origin frame reaches operator only through exact admitted route generation", async () => {
  const ctx = fixture();
  const envelope = ctx.gate.frameEnvelope(
    ctx.route.interventionId,
    ctx.route.epoch,
    frame(7)
  );
  assert.deepEqual(
    {
      version: envelope.version,
      type: envelope.type,
      interventionId: envelope.interventionId,
      epoch: envelope.epoch,
      workerGeneration: envelope.workerGeneration
    },
    {
      version: 1,
      type: "frame",
      interventionId: "intervention-1",
      epoch: 5,
      workerGeneration: 1
    }
  );

  await ctx.ingress.accept(envelope);
  assert.deepEqual(ctx.delivered, [7]);
});

test("control plane rejects a stale worker generation before operator frame delivery", async () => {
  const ctx = fixture();
  const envelope = ctx.gate.frameEnvelope(
    ctx.route.interventionId,
    ctx.route.epoch,
    frame(8)
  );

  await assert.rejects(
    ctx.ingress.accept({ ...envelope, workerGeneration: envelope.workerGeneration + 1 }),
    (error: unknown) => error instanceof HostedWorkerFrameError
      && error.code === "HOSTED_WORKER_FRAME_STALE_ROUTE"
  );
  assert.deepEqual(ctx.delivered, []);
});

test("worker gate cannot produce a frame after route revoke", () => {
  const ctx = fixture();
  ctx.gate.applyControl({
    version: 1,
    type: "revoke",
    interventionId: ctx.route.interventionId,
    epoch: ctx.route.epoch,
    workerGeneration: ctx.route.workerGeneration
  });

  assert.throws(
    () => ctx.gate.frameEnvelope(ctx.route.interventionId, ctx.route.epoch, frame(9)),
    (error: unknown) => error instanceof HostedWorkerFrameError
      && error.code === "HOSTED_WORKER_FRAME_STALE_ROUTE"
  );
});

test("stale viewer generation blocks worker frame before operator delivery", async () => {
  const ctx = fixture();
  const envelope = ctx.gate.frameEnvelope(
    ctx.route.interventionId,
    ctx.route.epoch,
    frame(10)
  );
  ctx.setOperator({ ...ctx.operator(), viewerGeneration: 2 });

  await assert.rejects(ctx.ingress.accept(envelope), /viewer generation is stale/);
  assert.deepEqual(ctx.delivered, []);
});

test("worker frame envelope is closed-world and cannot assert worker identity or provider data", async () => {
  const ctx = fixture();
  const envelope = ctx.gate.frameEnvelope(
    ctx.route.interventionId,
    ctx.route.epoch,
    frame(11)
  );

  for (const extra of [
    { workerId: "worker-b" },
    { channelBinding: "c".repeat(64) },
    { provider: "example" },
    { credential: "forbidden" }
  ]) {
    await assert.rejects(
      ctx.ingress.accept({ ...envelope, ...extra }),
      (error: unknown) => error instanceof HostedWorkerFrameError
        && error.code === "HOSTED_WORKER_FRAME_INVALID"
    );
  }
  assert.deepEqual(ctx.delivered, []);
});

test("worker frame shape is validated before an envelope can be created", () => {
  const ctx = fixture();
  assert.throws(
    () => ctx.gate.frameEnvelope(
      ctx.route.interventionId,
      ctx.route.epoch,
      { ...frame(12), width: 0 }
    ),
    /Hosted frame is invalid/
  );
});
