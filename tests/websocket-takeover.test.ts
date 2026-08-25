import assert from "node:assert/strict";
import test from "node:test";
import {
  ExperimentalWebSocketTakeoverChannel,
  WebSocketTakeoverError,
  type WebSocketTakeoverFrame
} from "../src/experimental/websocket-takeover.js";

interface HarnessOverrides {
  failControl?: boolean;
  failComplete?: boolean;
  failInput?: boolean;
  failFrame?: boolean;
  failBuffered?: boolean;
  failReleaseAttempts?: number;
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createHarness(overrides: HarnessOverrides = {}) {
  const controls: object[] = [];
  const frames: number[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  const inputs: object[] = [];
  const calls = { begin: 0, end: 0, complete: 0, release: 0 };
  let buffered = 0;
  let frameGate: ReturnType<typeof deferred> | undefined;
  let failBegin = false;
  let releaseFailuresLeft = overrides.failReleaseAttempts ?? 0;

  const channel = new ExperimentalWebSocketTakeoverChannel({
    binding: {
      interventionId: "intervention",
      epoch: 3,
      principalBinding: "principal",
      clientBinding: "client",
      clientGeneration: 1
    },
    inputPolicy: { tap: true, scroll: true, text: false, key: false },
    peer: {
      async sendControl(message) {
        controls.push(message);
        if (overrides.failControl) throw new Error("control failed");
      },
      async sendFrame(frame) {
        frames.push(frame.data[0] ?? -1);
        if (frameGate) await frameGate.promise;
        if (overrides.failFrame) throw new Error("frame failed");
      },
      bufferedAmount() {
        if (overrides.failBuffered) throw new Error("buffered amount failed");
        return buffered;
      },
      async close(code, reason) {
        closes.push({ code, reason });
      }
    },
    lease: {
      async beginUse(binding) {
        calls.begin += 1;
        assert.equal(binding.clientGeneration, 1);
        if (failBegin) throw new Error("stale");
      },
      async endUse() {
        calls.end += 1;
      },
      async complete() {
        calls.complete += 1;
        if (overrides.failComplete) throw new Error("stale complete");
      },
      async release() {
        calls.release += 1;
        if (releaseFailuresLeft > 0) {
          releaseFailuresLeft -= 1;
          throw new Error("release failed");
        }
      }
    },
    maxBufferedBytes: 8,
    onInput(input) {
      inputs.push(input);
      if (overrides.failInput) throw new Error("input failed");
    }
  });

  return {
    channel,
    controls,
    frames,
    closes,
    inputs,
    calls,
    setBuffered(value: number) {
      buffered = value;
    },
    blockFrames() {
      frameGate = deferred();
      return frameGate;
    },
    setFailBegin(value: boolean) {
      failBegin = value;
    }
  };
}

function frame(id: number): WebSocketTakeoverFrame {
  return {
    data: Uint8Array.from([id]),
    width: 640,
    height: 480,
    mimeType: "image/jpeg"
  };
}

test("WebSocket takeover bounds input with explicit policy", async () => {
  const h = createHarness();
  await h.channel.start();
  await h.channel.receiveText(JSON.stringify({ kind: "tap", x: 0.25, y: 0.5 }));
  await h.channel.receiveText(JSON.stringify({ kind: "scroll", deltaY: 300 }));

  assert.deepEqual(h.inputs, [
    { kind: "tap", x: 0.25, y: 0.5 },
    { kind: "scroll", deltaY: 300 }
  ]);
  assert.equal(h.calls.begin, 3);
  assert.equal(h.calls.end, 3);
  assert.deepEqual(h.controls[0], { kind: "ready" });

  await assert.rejects(
    h.channel.receiveText(JSON.stringify({ kind: "text", text: "secret" })),
    (error) => error instanceof WebSocketTakeoverError && error.code === "input_not_allowed"
  );
  assert.equal(h.channel.state, "failed");
  assert.equal(h.calls.release, 1);
  assert.deepEqual(h.closes.at(-1), { code: 1008, reason: "input_not_allowed" });
});

test("WebSocket protocol refuses peer-supplied ingress identity and Origin fields", async () => {
  const h = createHarness();
  await assert.rejects(
    h.channel.receiveText(JSON.stringify({
      kind: "tap",
      x: 0.5,
      y: 0.5,
      principalBinding: "attacker",
      origin: "https://untrusted.example"
    })),
    (error) => error instanceof WebSocketTakeoverError && error.code === "invalid_message"
  );
  assert.deepEqual(h.inputs, []);
  assert.equal(h.channel.state, "failed");
});

test("WebSocket ready is generation-fenced before control traffic", async () => {
  const h = createHarness();
  h.setFailBegin(true);

  await assert.rejects(
    h.channel.start(),
    (error) => error instanceof WebSocketTakeoverError && error.code === "stale_generation"
  );
  assert.deepEqual(h.controls, [{ kind: "error", code: "stale_generation" }]);
  assert.equal(h.calls.release, 1);
  assert.equal(h.channel.state, "failed");
});

test("WebSocket pong is generation-fenced before control traffic", async () => {
  const h = createHarness();
  await h.channel.start();
  h.setFailBegin(true);

  await assert.rejects(
    h.channel.receiveText(JSON.stringify({ kind: "ping", nonce: "one" })),
    (error) => error instanceof WebSocketTakeoverError && error.code === "stale_generation"
  );
  assert.equal(h.controls.some((message) => "kind" in message && message.kind === "pong"), false);
  assert.equal(h.channel.state, "failed");
});

test("WebSocket takeover rejects a stale generation before target input", async () => {
  const h = createHarness();
  h.setFailBegin(true);

  await assert.rejects(
    h.channel.receiveText(JSON.stringify({ kind: "tap", x: 0.5, y: 0.5 })),
    (error) => error instanceof WebSocketTakeoverError && error.code === "stale_generation"
  );
  assert.deepEqual(h.inputs, []);
  assert.equal(h.calls.release, 1);
  assert.equal(h.channel.diagnostics.lastFailure, "stale_generation");
  assert.deepEqual(h.closes.at(-1), { code: 1008, reason: "stale_generation" });
});

test("WebSocket takeover keeps only the newest pending frame", async () => {
  const h = createHarness();
  const gate = h.blockFrames();

  const first = h.channel.pushFrame(frame(1));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await h.channel.pushFrame(frame(2));
  await h.channel.pushFrame(frame(3));
  assert.deepEqual(h.frames, [1]);
  assert.equal(h.channel.diagnostics.droppedFrames, 1);

  gate.resolve();
  await first;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(h.frames, [1, 3]);
  assert.equal(h.channel.diagnostics.sentFrames, 2);
});

test("WebSocket takeover flushes the newest frame after backlog clears", async () => {
  const h = createHarness();
  h.setBuffered(99);
  await h.channel.pushFrame(frame(1));
  await h.channel.pushFrame(frame(2));
  assert.deepEqual(h.frames, []);
  assert.equal(h.channel.diagnostics.droppedFrames, 1);

  h.setBuffered(0);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(h.frames, [2]);
});

test("WebSocket configured limits have non-overridable hard ceilings", () => {
  const options = {
    binding: {
      interventionId: "intervention",
      epoch: 1,
      principalBinding: "principal",
      clientBinding: "client",
      clientGeneration: 1
    },
    inputPolicy: { tap: true, scroll: true, text: false, key: false },
    peer: {
      sendControl() {},
      sendFrame() {},
      bufferedAmount() { return 0; },
      close() {}
    },
    lease: {
      beginUse() {},
      endUse() {},
      complete() {},
      release() {}
    },
    onInput() {}
  };

  assert.throws(
    () => new ExperimentalWebSocketTakeoverChannel({
      ...options,
      maxInboundBytes: 64 * 1024 + 1
    }),
    /maxInboundBytes/
  );
  assert.throws(
    () => new ExperimentalWebSocketTakeoverChannel({
      ...options,
      maxFrameBytes: 8 * 1024 * 1024 + 1
    }),
    /maxFrameBytes/
  );
  assert.throws(
    () => new ExperimentalWebSocketTakeoverChannel({
      ...options,
      maxBufferedBytes: 4 * 1024 * 1024 + 1
    }),
    /maxBufferedBytes/
  );
});

test("WebSocket bufferedAmount failure fences the active generation", async () => {
  const h = createHarness({ failBuffered: true });
  await assert.rejects(
    h.channel.pushFrame(frame(1)),
    (error) => error instanceof WebSocketTakeoverError && error.code === "transport_failure"
  );
  assert.equal(h.channel.state, "failed");
  assert.equal(h.calls.release, 1);
  assert.deepEqual(h.frames, []);
});

test("WebSocket release failure stays failed and explicit revoke can retry cleanup", async () => {
  const h = createHarness({ failReleaseAttempts: 1 });

  await assert.rejects(
    h.channel.receiveText("not-json"),
    (error) => error instanceof WebSocketTakeoverError && error.code === "invalid_message"
  );
  assert.equal(h.channel.state, "failed");
  assert.equal(h.channel.diagnostics.lastFailure, "authority_release_failed");
  assert.equal(h.calls.release, 1);
  assert.deepEqual(h.closes.at(-1), { code: 1011, reason: "authority_release_failed" });

  await h.channel.revoke();
  assert.equal(h.calls.release, 2);
  assert.equal(h.channel.state, "revoked");
  assert.deepEqual(h.closes.at(-1), { code: 1000, reason: "revoked" });
});

test("WebSocket disconnect releases transport but never means Done", async () => {
  const h = createHarness();
  await h.channel.disconnect();
  await h.channel.disconnect();

  assert.equal(h.channel.state, "closed");
  assert.equal(h.calls.complete, 0);
  assert.equal(h.calls.release, 1);
});

test("WebSocket Done is one-shot and fences later input", async () => {
  const h = createHarness();
  const firstDone = h.channel.receiveText(JSON.stringify({ kind: "done" }));
  const secondDone = h.channel.receiveText(JSON.stringify({ kind: "done" }));
  const lateInput = h.channel.receiveText(
    JSON.stringify({ kind: "tap", x: 0.2, y: 0.2 })
  );
  await Promise.all([firstDone, secondDone, lateInput]);

  assert.equal(h.calls.complete, 1);
  assert.equal(h.calls.release, 0);
  assert.deepEqual(h.inputs, []);
  assert.deepEqual(h.controls, [{ kind: "closing" }, { kind: "closed" }]);
  assert.deepEqual(h.closes, [{ code: 1000, reason: "done" }]);
  assert.equal(h.channel.state, "closed");
});

test("WebSocket target input failure fences after ending bound use", async () => {
  const h = createHarness({ failInput: true });
  await assert.rejects(
    h.channel.receiveText(JSON.stringify({ kind: "tap", x: 0.1, y: 0.1 })),
    /input failed/
  );
  assert.equal(h.calls.begin, 1);
  assert.equal(h.calls.end, 1);
  assert.equal(h.calls.release, 1);
  assert.equal(h.channel.state, "failed");
  assert.equal(h.channel.diagnostics.lastFailure, "transport_failure");
});

test("WebSocket control failure fences after ending bound use", async () => {
  const h = createHarness({ failControl: true });
  await assert.rejects(h.channel.start(), /control failed/);
  assert.equal(h.calls.begin, 1);
  assert.equal(h.calls.end, 1);
  assert.equal(h.calls.release, 1);
  assert.equal(h.channel.state, "failed");
});

test("WebSocket completion rejection fences and never reports closed", async () => {
  const h = createHarness({ failComplete: true });
  await assert.rejects(
    h.channel.receiveText(JSON.stringify({ kind: "done" })),
    /stale complete/
  );
  assert.equal(h.calls.complete, 1);
  assert.equal(h.calls.release, 1);
  assert.equal(h.channel.state, "failed");
  assert.equal(h.controls.some((message) => "kind" in message && message.kind === "closed"), false);
});

test("WebSocket frame delivery failure fences the active generation", async () => {
  const h = createHarness({ failFrame: true });
  await assert.rejects(h.channel.pushFrame(frame(1)), /frame failed/);
  assert.equal(h.calls.begin, 1);
  assert.equal(h.calls.end, 1);
  assert.equal(h.calls.release, 1);
  assert.equal(h.channel.state, "failed");
});

test("WebSocket invalid frame fails closed", async () => {
  const h = createHarness();
  await assert.rejects(
    h.channel.pushFrame({
      data: new Uint8Array(),
      width: 640,
      height: 480,
      mimeType: "image/jpeg"
    }),
    (error) => error instanceof WebSocketTakeoverError && error.code === "frame_too_large"
  );
  assert.equal(h.channel.state, "failed");
  assert.equal(h.calls.release, 1);
  assert.deepEqual(h.frames, []);
});
