import assert from "node:assert/strict";
import test from "node:test";
import {
  ManagedOperatorDiagnosticEvents,
  emptyManagedOperatorDiagnosticsSnapshot,
  parseManagedOperatorDiagnosticsSnapshot,
  type ManagedOperatorDiagnosticsSnapshot
} from "../src/browser-takeover/managed-operator-diagnostics.js";

function snapshot(): ManagedOperatorDiagnosticsSnapshot {
  return {
    version: 1,
    source: "browser_handoff",
    namespace: "managed_handoff",
    health: "degraded",
    currentTransport: "websocket_relay",
    previousTransport: "webrtc_direct",
    generation: 2,
    transitionCount: 1,
    fallbackReason: "transport_unavailable",
    wss: {
      namespace: "managed_wss",
      channelState: "failed",
      channelFailure: "transport_failure",
      disconnectKind: "channel_failure",
      framesObserved: 12,
      framesSent: 10,
      framesDropped: 2,
      surfaceFailure: "input_timeout",
      inputAttempts: 1,
      lastInputStage: "pointer_down_sent",
      lastInputBoundaryStage: "command_sent",
      helperStopReason: "input_failure",
      helperCrashReason: "none",
      helperExitKind: "nonzero",
      helperCrashClass: "xtest_callback",
      helperCrashOrigin: "uncaught_exception",
      helperCrashErrorKind: "error",
      helperCrashMessageClass: "xtest_helper_ack_timeout",
      authorityBoundary: "valid",
      sessionDisposition: "retained"
    },
    events: [
      { kind: "transport_transition" },
      { kind: "wss_open" },
      { kind: "input_dispatch_failure" },
      { kind: "wss_failed" },
      { kind: "session_retained" }
    ]
  };
}

test("managed operator diagnostics parser accepts only the strict content-free v1 schema", () => {
  const value = snapshot();
  assert.deepEqual(parseManagedOperatorDiagnosticsSnapshot(value), value);

  const rootSecrets = [
    "credential", "mfa", "otp", "passkey", "cookie", "token", "capability", "humanInput",
    "framebuffer", "browserContent", "processId", "windowId", "principal", "interventionId",
    "sessionId", "ip", "iceCandidate", "sdp", "turnCredential", "accountIdentity", "message"
  ];
  for (const key of rootSecrets) {
    assert.throws(
      () => parseManagedOperatorDiagnosticsSnapshot({ ...value, [key]: "forbidden" }),
      /Invalid managed operator diagnostics snapshot/
    );
  }

  for (const key of rootSecrets) {
    assert.throws(
      () => parseManagedOperatorDiagnosticsSnapshot({
        ...value,
        wss: { ...value.wss, [key]: "forbidden" }
      }),
      /Invalid managed operator diagnostics snapshot/
    );
  }

  assert.throws(() => parseManagedOperatorDiagnosticsSnapshot({
    ...value,
    events: [{ kind: "wss_failed", sessionId: "forbidden" }]
  }), /Invalid managed operator diagnostics snapshot/);
  assert.throws(() => parseManagedOperatorDiagnosticsSnapshot({
    ...value,
    wss: { ...value.wss, framesSent: 1_000_001 }
  }), /Invalid managed operator diagnostics snapshot/);
  assert.throws(() => parseManagedOperatorDiagnosticsSnapshot({
    ...value,
    wss: { ...value.wss, helperCrashMessageClass: "free-form failure text" }
  }), /Invalid managed operator diagnostics snapshot/);
});

test("managed operator event history is bounded and contains enum-only records", () => {
  const events = new ManagedOperatorDiagnosticEvents();
  for (let index = 0; index < 80; index += 1) events.record("transport_transition");
  const captured = events.snapshot();
  assert.equal(captured.length, 64);
  assert.deepEqual(new Set(captured.map((event) => Object.keys(event).join(","))), new Set(["kind"]));
  assert.deepEqual(new Set(captured.map((event) => event.kind)), new Set(["transport_transition"]));
});

test("empty managed operator diagnostics gives Browser and Window one source-compatible read path", () => {
  for (const source of ["browser_handoff", "window_handoff"] as const) {
    const value = emptyManagedOperatorDiagnosticsSnapshot(source);
    assert.deepEqual(parseManagedOperatorDiagnosticsSnapshot(value), value);
    assert.equal(value.health, "idle");
    assert.equal(value.currentTransport, "none");
    assert.equal(value.previousTransport, "none");
    assert.equal(value.wss.authorityBoundary, "valid");
    assert.equal(value.wss.sessionDisposition, "none");
    assert.deepEqual(value.events, []);
  }
});

test("managed diagnostic observer is bounded and observe-only", () => {
  const observed: unknown[] = [];
  const events = new ManagedOperatorDiagnosticEvents((event) => {
    observed.push(event);
    if (event.kind === "wss_failed") throw new Error("operator sink unavailable");
  });

  assert.doesNotThrow(() => events.record("wss_open"));
  assert.doesNotThrow(() => events.record("wss_failed"));
  assert.deepEqual(observed, [{ kind: "wss_open" }, { kind: "wss_failed" }]);
  assert.deepEqual(events.snapshot(), [{ kind: "wss_open" }, { kind: "wss_failed" }]);
  assert.deepEqual(observed.map((event) => Object.keys(event as object)), [["kind"], ["kind"]]);
});
