import assert from "node:assert/strict";
import test from "node:test";
import { WebRtcLatencyTracker, parseWebRtcLatencySample } from "../src/browser-takeover/webrtc-latency.js";

test("WebRTC latency tracker compares direct and relay using bounded identifier-free process memory", () => {
  const tracker = new WebRtcLatencyTracker();
  tracker.record({ path: "direct", rttMs: 8.04, firstFrameMs: 120.04 });
  tracker.record({ path: "direct", rttMs: 12.06, firstFrameMs: 150.06 });
  tracker.record({
    path: "relay", rttMs: 61.04, firstFrameMs: 330.04, jitterMs: 11.04, jitterBufferMs: 87.04,
    jitterBufferTargetMs: 95.04, jitterBufferMinimumMs: 20.04, avgDecodeMs: 9.04, avgProcessingMs: 102.04,
    senderTimelineToDisplayMs: 244.04, senderTimelineToReceiveMs: 51.04, receiveToDisplayMs: 193.04,
    frameDecodeMs: 8.04, compositorMs: 15.04, inputAckMs: 45.04, hostEncodeMs: 4.04, rtpDrainMs: 3.04
  });
  const snapshot = tracker.snapshot();
  assert.deepEqual(snapshot.direct.rtt, { count: 2, p50Ms: 8, p95Ms: 12.1, maxMs: 12.1 });
  assert.deepEqual(snapshot.relay.firstFrame, { count: 1, p50Ms: 330, p95Ms: 330, maxMs: 330 });
  assert.deepEqual(snapshot.relay.senderTimelineToDisplay, { count: 1, p50Ms: 244, p95Ms: 244, maxMs: 244 });
  assert.deepEqual(snapshot.relay.jitterBufferTarget, { count: 1, p50Ms: 95, p95Ms: 95, maxMs: 95 });
  assert.deepEqual(snapshot.relay.jitterBufferMinimum, { count: 1, p50Ms: 20, p95Ms: 20, maxMs: 20 });
  assert.deepEqual(snapshot.relay.avgProcessing, { count: 1, p50Ms: 102, p95Ms: 102, maxMs: 102 });
  assert.deepEqual(snapshot.relay.inputAck, { count: 1, p50Ms: 45, p95Ms: 45, maxMs: 45 });
  assert.deepEqual(snapshot.relay.hostEncode, { count: 1, p50Ms: 4, p95Ms: 4, maxMs: 4 });
  assert.deepEqual(snapshot.relay.rtpDrain, { count: 1, p50Ms: 3, p95Ms: 3, maxMs: 3 });
  assert.equal(JSON.stringify(snapshot).includes("address"), false);
});

test("WebRTC latency parser accepts receiver timings but rejects server/network fields and out-of-range values", () => {
  assert.deepEqual(parseWebRtcLatencySample({
    path: "relay", rttMs: 25.25, firstFrameMs: 201.25, jitterMs: 3.25, jitterBufferMs: 41.25,
    jitterBufferTargetMs: 52.25, jitterBufferMinimumMs: 18.25, avgDecodeMs: 7.25, avgProcessingMs: 48.25,
    senderTimelineToDisplayMs: 90.25, senderTimelineToReceiveMs: 30.25, receiveToDisplayMs: 60.25,
    frameDecodeMs: 6.25, compositorMs: 16.25, inputAckMs: 44.25
  }), {
    path: "relay", rttMs: 25.3, firstFrameMs: 201.3, jitterMs: 3.3, jitterBufferMs: 41.3,
    jitterBufferTargetMs: 52.3, jitterBufferMinimumMs: 18.3, avgDecodeMs: 7.3, avgProcessingMs: 48.3,
    senderTimelineToDisplayMs: 90.3, senderTimelineToReceiveMs: 30.3, receiveToDisplayMs: 60.3,
    frameDecodeMs: 6.3, compositorMs: 16.3, inputAckMs: 44.3
  });
  assert.equal(parseWebRtcLatencySample({ path: "direct", rttMs: 1, candidateId: "candidate-1" }), undefined);
  assert.equal(parseWebRtcLatencySample({ path: "direct", rttMs: 1, hostEncodeMs: 4 }), undefined);
  assert.equal(parseWebRtcLatencySample({ path: "direct", rttMs: 1, rtpDrainMs: 4 }), undefined);
  assert.equal(parseWebRtcLatencySample({ path: "relay", rttMs: 999_999 }), undefined);
  assert.equal(parseWebRtcLatencySample({ path: "unknown", rttMs: 1 }), undefined);
});
