import assert from "node:assert/strict";
import test from "node:test";
import {
  browserHandoffTransportAttemptOrder,
  ManagedHandoffTransportPolicyError,
  nextBrowserHandoffTransportAttempt
} from "../src/browser-takeover/transport-fallback-policy.js";

test("managed transport policy preserves the requested default-shaped order", () => {
  assert.deepEqual(
    browserHandoffTransportAttemptOrder({
      order: ["webrtc_direct", "websocket_relay", "webrtc_relay"]
    }),
    ["webrtc_direct", "websocket_relay", "webrtc_relay"]
  );
});

test("managed transport policy permits arbitrary reviewed order without implicit insertion", () => {
  assert.deepEqual(
    browserHandoffTransportAttemptOrder({
      order: ["websocket_relay", "webrtc_direct", "webrtc_relay"]
    }),
    ["websocket_relay", "webrtc_direct", "webrtc_relay"]
  );
  assert.deepEqual(
    browserHandoffTransportAttemptOrder({ order: ["webrtc_relay", "websocket_relay"] }),
    ["webrtc_relay", "websocket_relay"]
  );
});

test("one-attempt plans are explicit transport-only modes", () => {
  assert.deepEqual(browserHandoffTransportAttemptOrder({ order: ["webrtc_direct"] }), ["webrtc_direct"]);
  assert.deepEqual(browserHandoffTransportAttemptOrder({ order: ["websocket_relay"] }), ["websocket_relay"]);
  assert.deepEqual(browserHandoffTransportAttemptOrder({ order: ["webrtc_relay"] }), ["webrtc_relay"]);
});

test("managed transport policy rejects empty duplicate unknown and extra-field plans", () => {
  for (const policy of [
    { order: [] },
    { order: ["webrtc_direct", "webrtc_direct"] },
    { order: ["unknown"] },
    { order: ["webrtc_direct"], provider: "cloudflare" }
  ]) {
    assert.throws(
      () => browserHandoffTransportAttemptOrder(policy as never),
      (error: unknown) => error instanceof ManagedHandoffTransportPolicyError
    );
  }
});

test("the staged policy advances only from an attempt that belongs to the plan", () => {
  const order = browserHandoffTransportAttemptOrder({
    order: ["websocket_relay", "webrtc_direct", "webrtc_relay"]
  });
  assert.equal(nextBrowserHandoffTransportAttempt(order, "websocket_relay"), "webrtc_direct");
  assert.equal(nextBrowserHandoffTransportAttempt(order, "webrtc_direct"), "webrtc_relay");
  assert.equal(nextBrowserHandoffTransportAttempt(order, "webrtc_relay"), undefined);

  const directOnly = browserHandoffTransportAttemptOrder({ order: ["webrtc_direct"] });
  assert.equal(nextBrowserHandoffTransportAttempt(directOnly, "websocket_relay"), undefined);
});
