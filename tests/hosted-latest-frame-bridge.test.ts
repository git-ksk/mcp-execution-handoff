import assert from "node:assert/strict";
import test from "node:test";
import {
  HostedLatestFrameBridge,
  HostedLatestFrameBridgeError,
  HostedWorkerRegistry,
  bindHostedOperatorSession,
  type HostedEphemeralFrame,
  type HostedFramePeer,
  type HostedOperatorSessionReference
} from "../src/core/index.js";

const PRINCIPAL = "a".repeat(64);
const CHANNEL = "b".repeat(64);

function frame(marker: number): HostedEphemeralFrame {
  return {
    data: new Uint8Array([marker]),
    width: 100,
    height: 100,
    mimeType: "image/jpeg"
  };
}

function setup() {
  const registry = new HostedWorkerRegistry();
  const worker = registry.register({
    workerId: "worker-a",
    principalBinding: PRINCIPAL,
    channelBinding: CHANNEL
  });
  const route = registry.bindIntervention({
    interventionId: "intervention-1",
    epoch: 7,
    principalBinding: PRINCIPAL,
    workerId: worker.workerId,
    workerGeneration: worker.generation
  });
  let currentOperator: HostedOperatorSessionReference = {
    sessionId: "session-1",
    interventionId: "intervention-1",
    epoch: 7,
    principalBinding: PRINCIPAL,
    expiresAt: Date.now() + 60_000,
    viewerGeneration: 1
  };
  const binding = bindHostedOperatorSession(currentOperator, route, registry);
  return {
    registry,
    route,
    binding,
    currentOperator: () => currentOperator,
    setOperator(value: HostedOperatorSessionReference) {
      currentOperator = value;
    }
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

test("hosted frame bridge keeps only the latest pending frame while one send is in flight", async () => {
  const ctx = setup();
  const gate = deferred();
  const sent: number[] = [];
  let first = true;
  const peer: HostedFramePeer = {
    bufferedAmount: () => 0,
    async sendFrame(value) {
      sent.push(value.data[0]!);
      if (first) {
        first = false;
        await gate.promise;
      }
    }
  };
  const bridge = new HostedLatestFrameBridge({
    binding: ctx.binding,
    registry: ctx.registry,
    currentOperator: ctx.currentOperator,
    peer
  });

  const firstSend = bridge.publish(frame(1));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await bridge.publish(frame(2));
  await bridge.publish(frame(3));
  assert.deepEqual(sent, [1]);
  assert.deepEqual(bridge.diagnostics(), {
    state: "open",
    sending: true,
    pending: true,
    sentFrames: 0,
    droppedFrames: 1,
    backpressureEvents: 0
  });

  gate.resolve();
  await firstSend;
  assert.deepEqual(sent, [1, 3]);
  assert.equal(bridge.diagnostics().sentFrames, 2);
  assert.equal(bridge.diagnostics().pending, false);
});

test("backpressure stores one latest frame and explicit drain sends only the newest", async () => {
  const ctx = setup();
  const sent: number[] = [];
  let buffered = 900_000;
  const peer: HostedFramePeer = {
    bufferedAmount: () => buffered,
    async sendFrame(value) {
      sent.push(value.data[0]!);
    }
  };
  const bridge = new HostedLatestFrameBridge({
    binding: ctx.binding,
    registry: ctx.registry,
    currentOperator: ctx.currentOperator,
    peer
  });

  await bridge.publish(frame(1));
  await bridge.publish(frame(2));
  await bridge.publish(frame(3));
  assert.deepEqual(sent, []);
  assert.equal(bridge.diagnostics().droppedFrames, 2);
  assert.equal(bridge.diagnostics().pending, true);

  buffered = 0;
  await bridge.drain();
  assert.deepEqual(sent, [3]);
  assert.equal(bridge.diagnostics().pending, false);
});

test("stale viewer generation is revalidated before frame delivery", async () => {
  const ctx = setup();
  const sent: number[] = [];
  const bridge = new HostedLatestFrameBridge({
    binding: ctx.binding,
    registry: ctx.registry,
    currentOperator: ctx.currentOperator,
    peer: {
      bufferedAmount: () => 0,
      sendFrame(value) {
        sent.push(value.data[0]!);
      }
    }
  });

  ctx.setOperator({ ...ctx.currentOperator(), viewerGeneration: 2 });
  await assert.rejects(bridge.publish(frame(1)), /viewer generation is stale/);
  assert.deepEqual(sent, []);
});

test("stale worker generation is revalidated before frame delivery", async () => {
  const ctx = setup();
  ctx.registry.disconnect("worker-a", ctx.route.workerGeneration, CHANNEL);
  const bridge = new HostedLatestFrameBridge({
    binding: ctx.binding,
    registry: ctx.registry,
    currentOperator: ctx.currentOperator,
    peer: { bufferedAmount: () => 0, sendFrame() {} }
  });

  await assert.rejects(bridge.publish(frame(1)), /no longer current/);
});

test("transport send failure closes bridge and drops pending frame", async () => {
  const ctx = setup();
  const bridge = new HostedLatestFrameBridge({
    binding: ctx.binding,
    registry: ctx.registry,
    currentOperator: ctx.currentOperator,
    peer: {
      bufferedAmount: () => 0,
      sendFrame() {
        throw new Error("synthetic transport failure");
      }
    }
  });
  await assert.rejects(
    bridge.publish(frame(1)),
    (error: unknown) => error instanceof HostedLatestFrameBridgeError
      && error.code === "HOSTED_FRAME_TRANSPORT_FAILURE"
  );
  assert.equal(bridge.diagnostics().state, "closed");
  await assert.rejects(
    bridge.publish(frame(2)),
    (error: unknown) => error instanceof HostedLatestFrameBridgeError
      && error.code === "HOSTED_FRAME_BRIDGE_CLOSED"
  );
});

test("frame validation is bounded and content stays out of diagnostics", async () => {
  const ctx = setup();
  const bridge = new HostedLatestFrameBridge({
    binding: ctx.binding,
    registry: ctx.registry,
    currentOperator: ctx.currentOperator,
    peer: { bufferedAmount: () => 0, sendFrame() {} }
  });

  await assert.rejects(
    bridge.publish({ ...frame(1), width: 0 }),
    (error: unknown) => error instanceof HostedLatestFrameBridgeError
      && error.code === "HOSTED_FRAME_INVALID"
  );
  const encoded = JSON.stringify(bridge.diagnostics());
  assert.doesNotMatch(encoded, /session|intervention|principal|worker|frame.*data|credential|token/i);
});
