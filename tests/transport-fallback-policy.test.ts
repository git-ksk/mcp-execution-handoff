import assert from "node:assert/strict";
import test from "node:test";
import {
  browserHandoffTransportAttemptOrder,
  nextBrowserHandoffTransportAttempt
} from "../src/browser-takeover/transport-fallback-policy.js";

test("managed runtime fallback prefers direct WebRTC then WSS then optional TURN", () => {
  assert.deepEqual(
    browserHandoffTransportAttemptOrder({ websocketRelayEnabled: true, webrtcRelayEnabled: true }),
    ["webrtc_direct", "websocket_relay", "webrtc_relay"]
  );
});

test("TURN is never placed ahead of the Cloud Run WebSocket fallback", () => {
  assert.deepEqual(
    browserHandoffTransportAttemptOrder({ websocketRelayEnabled: true, webrtcRelayEnabled: false }),
    ["webrtc_direct", "websocket_relay"]
  );
  assert.deepEqual(
    browserHandoffTransportAttemptOrder({ websocketRelayEnabled: false, webrtcRelayEnabled: true }),
    ["webrtc_direct", "webrtc_relay"]
  );
});

test("direct WebRTC remains the only attempt when no fallback is configured", () => {
  assert.deepEqual(
    browserHandoffTransportAttemptOrder({ websocketRelayEnabled: false, webrtcRelayEnabled: false }),
    ["webrtc_direct"]
  );
});

test("the staged policy advances only from an attempt that belongs to the plan", () => {
  const order = browserHandoffTransportAttemptOrder({
    websocketRelayEnabled: true,
    webrtcRelayEnabled: true
  });
  assert.equal(nextBrowserHandoffTransportAttempt(order, "webrtc_direct"), "websocket_relay");
  assert.equal(nextBrowserHandoffTransportAttempt(order, "websocket_relay"), "webrtc_relay");
  assert.equal(nextBrowserHandoffTransportAttempt(order, "webrtc_relay"), undefined);

  const noWebSocket = browserHandoffTransportAttemptOrder({
    websocketRelayEnabled: false,
    webrtcRelayEnabled: true
  });
  assert.equal(nextBrowserHandoffTransportAttempt(noWebSocket, "websocket_relay"), undefined);
});
