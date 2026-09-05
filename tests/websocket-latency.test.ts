import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketLatencyTracker } from "../src/browser-takeover/websocket-latency.js";
import {
  ExperimentalWebSocketTakeoverChannel,
  type WebSocketTakeoverBinding,
  type WebSocketTakeoverLease,
  type WebSocketTakeoverPeer
} from "../src/browser-takeover/websocket-takeover.js";

const binding: WebSocketTakeoverBinding = {
  interventionId: "latency-fixture",
  epoch: 1,
  principalBinding: "principal",
  clientBinding: "abcdefghijklmnopqrstuvwx",
  clientGeneration: 1
};

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

function lease(overrides: Partial<WebSocketTakeoverLease> = {}): WebSocketTakeoverLease {
  return {
    beginUse: async () => undefined,
    endUse: async () => undefined,
    complete: async () => undefined,
    release: async () => undefined,
    ...overrides
  };
}

function peer(): WebSocketTakeoverPeer {
  return {
    sendControl: async () => undefined,
    sendFrame: async () => { await tick(); },
    bufferedAmount: () => 0,
    close: async () => undefined
  };
}

test("WSS latency tracker is bounded, rounded and contains distributions only", () => {
  const tracker = new WebSocketLatencyTracker();
  for (let index = 0; index < 160; index += 1) tracker.record("capture", index + 0.04);
  tracker.record("frame_send", Number.NaN);
  tracker.record("input_apply", 120_001);
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.capture.count, 128);
  assert.equal(snapshot.frameSend.count, 0);
  assert.equal(snapshot.inputApply.count, 0);
  assert.equal(snapshot.samples, 128);
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "capture", "captureFrameWait", "capturePrepare", "captureRevalidate", "clientFirstFrame",
    "clientFirstReady", "clientFrameCadence", "clientFrameDecode", "clientReadyToFirstFrame",
    "clientReconnectFrame", "clientReconnectReady", "completionFence",
    "frameCadence", "frameSend", "inputApply",
    "inputHostAck", "inputPrepare", "inputQueueWait",
    "inputRevalidate", "revokeFence", "samples"
  ].sort());
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of [
    "sessionId", "interventionId", "principal", "capability", "token", "cookie", "credential",
    "framebuffer", "humanInput", "url", "address", "timestamp"
  ]) assert.equal(serialized.includes(forbidden), false);
});

test("WSS channel records server stages plus validated browser frame diagnostics", async () => {
  const tracker = new WebSocketLatencyTracker();
  const channel = new ExperimentalWebSocketTakeoverChannel({
    binding,
    inputPolicy: { tap: true, scroll: true, text: true, key: true },
    peer: peer(),
    lease: lease({ complete: async () => { await tick(); } }),
    latencyTracker: tracker,
    onInput: async () => { await tick(); }
  });
  await channel.start();
  await channel.pushFrame({ data: new Uint8Array([1]), width: 1, height: 1, mimeType: "image/jpeg" });
  await channel.pushFrame({ data: new Uint8Array([2]), width: 1, height: 1, mimeType: "image/jpeg" });
  await channel.receiveText(JSON.stringify({ kind: "latency", metric: "client_frame_decode", valueMs: 3.26 }));
  await channel.receiveText(JSON.stringify({ kind: "latency", metric: "client_frame_cadence", valueMs: 76.14 }));
  await channel.receiveText(JSON.stringify({ kind: "latency", metric: "client_first_frame", valueMs: 118.26 }));
  await channel.receiveText(JSON.stringify({ kind: "latency", metric: "client_first_ready", valueMs: 42.14 }));
  await channel.receiveText(JSON.stringify({ kind: "latency", metric: "client_ready_to_first_frame", valueMs: 76.12 }));
  await channel.receiveText(JSON.stringify({ kind: "latency", metric: "client_reconnect_frame", valueMs: 742.34 }));
  await channel.receiveText(JSON.stringify({ kind: "latency", metric: "client_reconnect_ready", valueMs: 611.26 }));
  await channel.receiveText(JSON.stringify({ kind: "tap", x: 0.5, y: 0.5 }));
  await channel.receiveText(JSON.stringify({ kind: "done" }));
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.frameSend.count, 2);
  assert.equal(snapshot.frameCadence.count, 1);
  assert.equal(snapshot.clientFrameDecode.count, 1);
  assert.equal(snapshot.clientFrameCadence.count, 1);
  assert.equal(snapshot.clientFirstFrame.count, 1);
  assert.equal(snapshot.clientFirstReady.count, 1);
  assert.equal(snapshot.clientReadyToFirstFrame.count, 1);
  assert.equal(snapshot.clientReconnectFrame.count, 1);
  assert.equal(snapshot.clientReconnectReady.count, 1);
  assert.equal(snapshot.inputApply.count, 1);
  assert.equal(snapshot.completionFence.count, 1);
  assert.equal(snapshot.clientFrameDecode.p50Ms, 3.3);
  assert.equal(snapshot.clientFrameCadence.p50Ms, 76.1);
  assert.equal(snapshot.clientFirstFrame.p50Ms, 118.3);
  assert.equal(snapshot.clientFirstReady.p50Ms, 42.1);
  assert.equal(snapshot.clientReadyToFirstFrame.p50Ms, 76.1);
  assert.equal(snapshot.clientReconnectFrame.p50Ms, 742.3);
  assert.equal(snapshot.clientReconnectReady.p50Ms, 611.3);
});

test("WSS revoke fence timing is separate from Human completion timing", async () => {
  const tracker = new WebSocketLatencyTracker();
  const channel = new ExperimentalWebSocketTakeoverChannel({
    binding,
    inputPolicy: { tap: true, scroll: true, text: true, key: true },
    peer: peer(),
    lease: lease({ release: async () => { await tick(); } }),
    latencyTracker: tracker,
    onInput: async () => undefined
  });
  await channel.revoke();
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.revokeFence.count, 1);
  assert.equal(snapshot.completionFence.count, 0);
});

test("invalid client latency diagnostics fail closed instead of entering measurements", async () => {
  const tracker = new WebSocketLatencyTracker();
  const channel = new ExperimentalWebSocketTakeoverChannel({
    binding,
    inputPolicy: { tap: true, scroll: true, text: true, key: true },
    peer: peer(),
    lease: lease(),
    latencyTracker: tracker,
    onInput: async () => undefined
  });
  await assert.rejects(
    channel.receiveText(JSON.stringify({ kind: "latency", metric: "client_frame_decode", valueMs: 120_001 })),
    /Latency diagnostic is invalid/
  );
  assert.equal(channel.state, "failed");
  assert.equal(tracker.snapshot().samples, 0);
});
