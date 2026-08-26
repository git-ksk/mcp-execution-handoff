import assert from "node:assert/strict";
import test from "node:test";
import {
  WebRtcDiagnosticsTracker,
  parseBrowserWebRtcDiagnosticEvent,
  webRtcCandidateCountsFromSdp
} from "../src/browser-takeover/webrtc-diagnostics.js";

test("candidate diagnostics reduce SDP to bounded type counts only", () => {
  const sdp = [
    "v=0",
    "a=candidate:1 1 udp 1 10.0.0.1 5000 typ host",
    "a=candidate:2 1 udp 1 198.51.100.7 5001 typ srflx raddr 10.0.0.1 rport 5000",
    "a=candidate:3 1 udp 1 203.0.113.8 5002 typ relay",
    "a=candidate:4 1 udp 1 hidden.local 5003 typ host"
  ].join("\r\n");
  const counts = webRtcCandidateCountsFromSdp(sdp);
  assert.deepEqual(counts, { host: 2, srflx: 1, prflx: 0, relay: 1 });
  assert.doesNotMatch(JSON.stringify(counts), /10\.0\.0\.1|198\.51\.100\.7|203\.0\.113\.8|hidden\.local|candidate:/);
});

test("browser diagnostic parser fails closed on network, SDP and credential-shaped extra fields", () => {
  const safe = {
    stage: "browser.gather.complete",
    candidateCounts: { host: 1, srflx: 1, prflx: 0, relay: 0 },
    durationMs: 12.34
  };
  assert.deepEqual(parseBrowserWebRtcDiagnosticEvent(safe), { ...safe, durationMs: 12.3 });
  for (const extra of [
    { address: "192.0.2.1" },
    { candidate: "candidate:raw" },
    { sdp: "v=0" },
    { username: "turn-user" },
    { credential: "secret" },
    { sessionId: "session-id" }
  ]) {
    assert.equal(parseBrowserWebRtcDiagnosticEvent({ ...safe, ...extra }), undefined);
  }
});

test("relay credential diagnostics retain only a bounded failure reason", () => {
  const tracker = new WebRtcDiagnosticsTracker();
  tracker.record({ stage: "relay.credential.unavailable", reason: "provider_auth" });
  assert.deepEqual(tracker.snapshot(), {
    events: [{ stage: "relay.credential.unavailable", reason: "provider_auth" }]
  });
  tracker.record({ stage: "relay.credential.unavailable", reason: "secret-token" as never });
  assert.equal(tracker.snapshot().events.length, 1);
  assert.equal(parseBrowserWebRtcDiagnosticEvent({
    stage: "browser.peer.state", state: "failed", reason: "provider_auth"
  }), undefined);
});

test("diagnostic tracker remains bounded and snapshot cannot mutate stored events", () => {
  const tracker = new WebRtcDiagnosticsTracker();
  for (let i = 0; i < 140; i += 1) tracker.record({ stage: "broker.prepare.request" });
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.events.length, 128);
  snapshot.events[0]!.stage = "broker.connect.request";
  assert.equal(tracker.snapshot().events[0]!.stage, "broker.prepare.request");
});


test("native text route diagnostics retain only one bounded payload-free stage", () => {
  const tracker = new WebRtcDiagnosticsTracker();
  const stages = [
    "host.input.text.native_ax",
    "host.input.text.pid_keyboard",
    "host.input.text.event_creation_failure",
    "host.input.text.activation_rejected",
    "host.input.text.native_boundary_rejected"
  ] as const;
  for (const stage of stages) tracker.record({ stage });
  assert.deepEqual(tracker.snapshot(), { events: stages.map((stage) => ({ stage })) });
  tracker.record({
    stage: "host.input.text.native_ax",
    durationMs: 1
  });
  assert.equal(tracker.snapshot().events.length, stages.length);
  assert.equal(
    tracker.snapshot().events.every((event) => Object.keys(event).length === 1 && Object.keys(event)[0] === "stage"),
    true
  );
});


test("Linux pointer delivery diagnostics retain only bounded stage names", () => {
  const tracker = new WebRtcDiagnosticsTracker();
  const stages = [
    "host.input.pointer.delivery_helper_ready",
    "host.input.pointer.delivery_helper_failure",
    "host.input.pointer.delivery_arm_failure",
    "host.input.pointer.delivery_wait_no_from_server_creator_match",
    "host.input.pointer.delivery_wait_no_from_server_creator_mismatch",
    "host.input.pointer.delivery_wait_no_from_server_creator_unknown",
    "host.input.pointer.delivery_wait_swapped",
    "host.input.pointer.delivery_wait_short_data",
    "host.input.pointer.delivery_wait_no_event",
    "host.input.pointer.delivery_wait_event_mismatch",
    "host.input.pointer.delivery_wait_xi2_mismatch",
    "host.input.pointer.delivery_wait_window_mismatch",
    "host.input.pointer.delivery_wait_coord_mismatch",
    "host.input.pointer.delivery_wait_io_failure",
    "host.input.pointer.delivery_wait_failure",
    "host.input.pointer.delivery_ready"
  ] as const;
  for (const stage of stages) tracker.record({ stage });
  assert.deepEqual(tracker.snapshot(), { events: stages.map((stage) => ({ stage })) });
  tracker.record({ stage: "host.input.pointer.delivery_ready", durationMs: 1 });
  assert.equal(tracker.snapshot().events.length, stages.length);
});
