import assert from "node:assert/strict";
import test from "node:test";
import {
  HostedHumanInputBridge,
  HostedHumanInputError,
  HostedWorkerRegistry,
  HostedWorkerRouteGate,
  bindHostedOperatorSession,
  type HostedHumanInput,
  type HostedOperatorSessionReference
} from "../src/core/index.js";

const PRINCIPAL = "a".repeat(64);
const CHANNEL = "b".repeat(64);

function setup() {
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
    sessionId: "operator-1",
    interventionId: "intervention-1",
    epoch: 5,
    principalBinding: PRINCIPAL,
    expiresAt: Date.now() + 60_000,
    viewerGeneration: 1
  };
  const binding = bindHostedOperatorSession(operator, route, registry);
  return {
    registry,
    route,
    binding,
    operator: () => operator,
    setOperator(next: HostedOperatorSessionReference) { operator = next; }
  };
}

test("worker route gate applies input only after exact registered and bound generation", async () => {
  const gate = new HostedWorkerRouteGate();
  gate.applyControl({ version: 1, type: "registered", workerGeneration: 1 });
  gate.applyControl({
    version: 1,
    type: "bind",
    interventionId: "intervention-1",
    epoch: 5,
    workerGeneration: 1
  });

  const applied: HostedHumanInput[] = [];
  await gate.applyHumanInput({
    version: 1,
    type: "human_input",
    interventionId: "intervention-1",
    epoch: 5,
    workerGeneration: 1,
    input: { kind: "text", text: "bounded" }
  }, (input) => { applied.push(input); });
  assert.deepEqual(applied, [{ kind: "text", text: "bounded" }]);
});

test("worker route gate rejects stale generation epoch and revoked route", async () => {
  const gate = new HostedWorkerRouteGate();
  gate.applyControl({ version: 1, type: "registered", workerGeneration: 2 });
  gate.applyControl({
    version: 1,
    type: "bind",
    interventionId: "intervention-1",
    epoch: 7,
    workerGeneration: 2
  });

  for (const envelope of [
    {
      version: 1 as const, type: "human_input" as const, interventionId: "intervention-1",
      epoch: 7, workerGeneration: 1, input: { kind: "key" as const, key: "Enter" }
    },
    {
      version: 1 as const, type: "human_input" as const, interventionId: "intervention-1",
      epoch: 6, workerGeneration: 2, input: { kind: "key" as const, key: "Enter" }
    }
  ]) {
    await assert.rejects(
      gate.applyHumanInput(envelope, () => undefined),
      (error: unknown) => error instanceof HostedHumanInputError
        && error.code === "HOSTED_INPUT_STALE_ROUTE"
    );
  }

  gate.applyControl({
    version: 1,
    type: "revoke",
    interventionId: "intervention-1",
    epoch: 7,
    workerGeneration: 2
  });
  await assert.rejects(
    gate.applyHumanInput({
      version: 1,
      type: "human_input",
      interventionId: "intervention-1",
      epoch: 7,
      workerGeneration: 2,
      input: { kind: "key", key: "Enter" }
    }, () => undefined),
    /route is stale/
  );
});

test("control-plane input bridge carries exact route generation and never accepts concurrent replay queue", async () => {
  const ctx = setup();
  const gate = new HostedWorkerRouteGate();
  gate.applyControl({ version: 1, type: "registered", workerGeneration: 1 });
  gate.applyControl({
    version: 1,
    type: "bind",
    interventionId: "intervention-1",
    epoch: 5,
    workerGeneration: 1
  });

  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const applied: HostedHumanInput[] = [];
  let first = true;
  const bridge = new HostedHumanInputBridge(
    ctx.binding,
    ctx.registry,
    ctx.operator,
    {
      async sendInput(message) {
        await gate.applyHumanInput(message, async (input) => {
          applied.push(input);
          if (first) {
            first = false;
            await blocked;
          }
        });
      }
    }
  );

  const inFlight = bridge.dispatch({ kind: "tap", x: 0.5, y: 0.5 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(
    bridge.dispatch({ kind: "key", key: "Enter" }),
    (error: unknown) => error instanceof HostedHumanInputError
      && error.code === "HOSTED_INPUT_BUSY"
  );
  release();
  await inFlight;
  assert.deepEqual(applied, [{ kind: "tap", x: 0.5, y: 0.5 }]);
});

test("stale viewer is rejected at control plane before worker receives Human input", async () => {
  const ctx = setup();
  let sends = 0;
  const bridge = new HostedHumanInputBridge(
    ctx.binding,
    ctx.registry,
    ctx.operator,
    { sendInput() { sends += 1; } }
  );
  ctx.setOperator({ ...ctx.operator(), viewerGeneration: 2 });

  await assert.rejects(bridge.dispatch({ kind: "key", key: "Enter" }), /viewer generation is stale/);
  assert.equal(sends, 0);
});

test("worker generation change makes old bridge fail before transport delivery", async () => {
  const ctx = setup();
  let sends = 0;
  const bridge = new HostedHumanInputBridge(
    ctx.binding,
    ctx.registry,
    ctx.operator,
    { sendInput() { sends += 1; } }
  );
  ctx.registry.disconnect("worker-a", ctx.route.workerGeneration, CHANNEL);

  await assert.rejects(bridge.dispatch({ kind: "key", key: "Enter" }), /no longer current/);
  assert.equal(sends, 0);
});

test("input transport failure closes bridge and does not retry the Human input", async () => {
  const ctx = setup();
  let sends = 0;
  const bridge = new HostedHumanInputBridge(
    ctx.binding,
    ctx.registry,
    ctx.operator,
    {
      sendInput() {
        sends += 1;
        throw new Error("synthetic transport failure");
      }
    }
  );

  await assert.rejects(
    bridge.dispatch({ kind: "text", text: "secret-never-replayed" }),
    (error: unknown) => error instanceof HostedHumanInputError
      && error.code === "HOSTED_INPUT_TRANSPORT_FAILURE"
  );
  await assert.rejects(
    bridge.dispatch({ kind: "text", text: "secret-never-replayed" }),
    (error: unknown) => error instanceof HostedHumanInputError
      && error.code === "HOSTED_INPUT_CLOSED"
  );
  assert.equal(sends, 1);
});

test("hosted Human input parser is closed-world and bounded", async () => {
  const ctx = setup();
  const bridge = new HostedHumanInputBridge(
    ctx.binding,
    ctx.registry,
    ctx.operator,
    { sendInput() {} }
  );
  for (const value of [
    { kind: "tap", x: 2, y: 0 },
    { kind: "scroll", deltaY: 2001 },
    { kind: "text", text: "x".repeat(5000) },
    { kind: "key", key: "" },
    { kind: "key", key: "Enter", credential: "forbidden" }
  ]) {
    await assert.rejects(
      bridge.dispatch(value),
      (error: unknown) => error instanceof HostedHumanInputError
        && error.code === "HOSTED_INPUT_INVALID"
    );
  }
});
