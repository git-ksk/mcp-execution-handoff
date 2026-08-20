import assert from "node:assert/strict";
import test from "node:test";
import { WebRtcLatencyTracker, parseWebRtcLatencySample } from "../src/browser-takeover/webrtc-latency.js";

test("WebRTC latency tracker compares direct and relay using bounded identifier-free process memory", () => {
  const tracker = new WebRtcLatencyTracker();
  tracker.record({ path: "direct", rttMs: 8.04, firstFrameMs: 120.04 });
  tracker.record({ path: "direct", rttMs: 12.06, firstFrameMs: 150.06 });
  tracker.record({ path: "relay", rttMs: 61.04, firstFrameMs: 330.04 });
  const snapshot = tracker.snapshot();
  assert.deepEqual(snapshot.direct.rtt, { count: 2, p50Ms: 8, p95Ms: 12.1, maxMs: 12.1 });
  assert.deepEqual(snapshot.relay.firstFrame, { count: 1, p50Ms: 330, p95Ms: 330, maxMs: 330 });
  assert.equal(JSON.stringify(snapshot).includes("address"), false);
});

test("WebRTC latency parser rejects candidate/network identifiers and out-of-range timing", () => {
  assert.deepEqual(parseWebRtcLatencySample({ path: "relay", rttMs: 25.25, firstFrameMs: 201.25 }), {
    path: "relay", rttMs: 25.3, firstFrameMs: 201.3
  });
  assert.equal(parseWebRtcLatencySample({ path: "direct", rttMs: 1, candidateId: "candidate-1" }), undefined);
  assert.equal(parseWebRtcLatencySample({ path: "relay", rttMs: 999_999 }), undefined);
  assert.equal(parseWebRtcLatencySample({ path: "unknown", rttMs: 1 }), undefined);
});
