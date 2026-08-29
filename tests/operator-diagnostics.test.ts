import assert from "node:assert/strict";
import test from "node:test";
import {
  OPERATOR_DIAGNOSTICS_SCHEMA_VERSION,
  parseOperatorDiagnosticsSnapshot,
  type OperatorDiagnosticsSnapshot
} from "../src/core/index.js";
import {
  webRtcOperatorDiagnosticsSnapshot,
  type WebRtcDiagnosticsSnapshot
} from "../src/browser-takeover/webrtc-diagnostics.js";
import {
  terminalHandoffOperatorDiagnosticsSnapshot,
  type TerminalHandoffStatus
} from "../src/terminal-takeover/terminal-handoff-adapter.js";

const EMPTY_WEBRTC: WebRtcDiagnosticsSnapshot = { events: [] };

test("operator diagnostics v1 keeps Browser and Window in a transport namespace without invented authority", () => {
  const browser = webRtcOperatorDiagnosticsSnapshot("browser_handoff", EMPTY_WEBRTC);
  const window = webRtcOperatorDiagnosticsSnapshot("window_handoff", EMPTY_WEBRTC);
  assert.deepEqual(browser, {
    version: 1,
    source: "browser_handoff",
    health: "idle",
    transport: { namespace: "webrtc", eventCount: 0 }
  });
  assert.deepEqual(window, {
    version: 1,
    source: "window_handoff",
    health: "idle",
    transport: { namespace: "webrtc", eventCount: 0 }
  });
  assert.equal("authority" in browser, false);
  assert.equal("phase" in window, false);
});

test("WebRTC operator projection reduces detailed stages to bounded current health and transport facts", () => {
  const snapshot = webRtcOperatorDiagnosticsSnapshot("window_handoff", {
    events: [
      { stage: "broker.prepare.request" },
      { stage: "server.answer.ready", candidateCounts: { host: 1, srflx: 1, prflx: 0, relay: 1 }, durationMs: 22 },
      { stage: "server.peer.state", state: "connected" },
      { stage: "host.frame.ready" }
    ]
  });
  assert.deepEqual(snapshot, {
    version: 1,
    source: "window_handoff",
    health: "available",
    transport: {
      namespace: "webrtc",
      eventCount: 4,
      peerState: "connected",
      candidateCounts: { host: 1, srflx: 1, prflx: 0, relay: 1 }
    }
  });

  const degraded = webRtcOperatorDiagnosticsSnapshot("browser_handoff", {
    events: [{ stage: "server.peer.state", state: "disconnected" }]
  });
  assert.equal(degraded.health, "degraded");
  assert.equal(degraded.failureCategory, "transport");

  const failed = webRtcOperatorDiagnosticsSnapshot("window_handoff", {
    events: [{ stage: "host.window.failure.multiple" }]
  });
  assert.equal(failed.health, "failed");
  assert.equal(failed.failureCategory, "target");

  const recoveredGeneration = webRtcOperatorDiagnosticsSnapshot("window_handoff", {
    events: [
      { stage: "host.window.failure.multiple" },
      { stage: "broker.prepare.request" },
      { stage: "browser.gather.complete", candidateCounts: { host: 1, srflx: 0, prflx: 0, relay: 0 }, durationMs: 10 },
      { stage: "server.peer.state", state: "connected" }
    ]
  });
  assert.equal(recoveredGeneration.health, "available");
  assert.equal(recoveredGeneration.failureCategory, undefined);
  assert.equal(recoveredGeneration.transport.peerState, "connected");
});

test("WebRTC operator projection caps detailed event history at 128 without copying detailed stages", () => {
  const events = Array.from({ length: 140 }, () => ({ stage: "host.target.alive" as const }));
  const snapshot = webRtcOperatorDiagnosticsSnapshot("browser_handoff", { events });
  assert.equal(snapshot.transport.eventCount, 128);
  assert.equal(snapshot.health, "starting");
  assert.doesNotMatch(JSON.stringify(snapshot), /host\.target\.alive|stage|durationMs|media/i);
});

test("Terminal operator projection keeps authority/lifecycle and session detail bounded without PTY identity", () => {
  const status: TerminalHandoffStatus = {
    authority: "human",
    interventionStatus: "human_active",
    interventionEpoch: 9,
    sessionGeneration: 42,
    sessionAlive: true,
    humanDisconnected: false,
    agentStateSynchronizationRequired: false,
    transport: {
      transportReady: true,
      humanActive: true,
      disconnected: false,
      completed: false,
      faulted: false,
      queuedEvents: 3
    }
  };
  const snapshot = terminalHandoffOperatorDiagnosticsSnapshot(status);
  assert.deepEqual(snapshot, {
    version: 1,
    source: "terminal_handoff",
    health: "available",
    authority: "human",
    phase: "human_active",
    terminal: {
      namespace: "terminal_session",
      alive: true,
      humanDisconnected: false,
      synchronizationRequired: false
    },
    transport: {
      namespace: "terminal_webrtc",
      ready: true,
      disconnected: false,
      completed: false,
      faulted: false,
      queuedEvents: 3
    }
  });
  const encoded = JSON.stringify(snapshot);
  assert.doesNotMatch(encoded, /sessionGeneration|interventionEpoch|sessionId|principal|pty|clientGeneration/i);
});

test("Terminal operator health exposes expected synchronization/disconnect/session failures without identity", () => {
  const base: TerminalHandoffStatus = {
    authority: "none",
    interventionStatus: null,
    interventionEpoch: null,
    sessionGeneration: 8,
    sessionAlive: true,
    humanDisconnected: false,
    agentStateSynchronizationRequired: false,
    transport: null
  };
  assert.equal(terminalHandoffOperatorDiagnosticsSnapshot(base).health, "idle");
  const sync = terminalHandoffOperatorDiagnosticsSnapshot({ ...base, agentStateSynchronizationRequired: true });
  assert.equal(sync.health, "degraded");
  assert.equal(sync.failureCategory, undefined);
  const disconnected = terminalHandoffOperatorDiagnosticsSnapshot({ ...base, humanDisconnected: true });
  assert.equal(disconnected.health, "degraded");
  assert.equal(disconnected.failureCategory, "transport");
  const exited = terminalHandoffOperatorDiagnosticsSnapshot({ ...base, sessionAlive: false });
  assert.equal(exited.health, "failed");
  assert.equal(exited.failureCategory, "target");
});

test("operator diagnostics parser rejects identifiers content media network data and free-form strings", () => {
  const base: OperatorDiagnosticsSnapshot = {
    version: OPERATOR_DIAGNOSTICS_SCHEMA_VERSION,
    source: "browser_handoff",
    health: "available",
    transport: { namespace: "webrtc", eventCount: 1, peerState: "connected" }
  };
  assert.deepEqual(parseOperatorDiagnosticsSnapshot(base), base);
  for (const field of [
    "sessionId", "interventionId", "principalBinding", "processId", "windowId", "targetIdentity",
    "credential", "token", "candidate", "ip", "sdp", "framebuffer", "media", "humanInput",
    "ptyBytes", "browserContent", "accountIdentity", "message", "timestamp", "capability"
  ]) {
    assert.throws(() => parseOperatorDiagnosticsSnapshot({ ...base, [field]: "secret" }), /Invalid operator diagnostics snapshot/);
  }
});

test("operator diagnostics parser bounds WebRTC counts and Terminal queues and rejects false-parity fields", () => {
  assert.throws(() => parseOperatorDiagnosticsSnapshot({
    version: 1,
    source: "browser_handoff",
    health: "available",
    authority: "human",
    transport: { namespace: "webrtc", eventCount: 0 }
  }), /Invalid/);
  assert.throws(() => parseOperatorDiagnosticsSnapshot({
    version: 1,
    source: "window_handoff",
    health: "available",
    transport: { namespace: "webrtc", eventCount: 129 }
  }), /Invalid/);
  assert.throws(() => parseOperatorDiagnosticsSnapshot({
    version: 1,
    source: "browser_handoff",
    health: "available",
    transport: { namespace: "webrtc", eventCount: 1, candidateCounts: { host: 65, srflx: 0, prflx: 0, relay: 0 } }
  }), /Invalid/);
  assert.throws(() => parseOperatorDiagnosticsSnapshot({
    version: 1,
    source: "terminal_handoff",
    health: "available",
    authority: "human",
    phase: "human_active",
    terminal: { namespace: "terminal_session", alive: true, humanDisconnected: false, synchronizationRequired: false },
    transport: { namespace: "terminal_webrtc", ready: true, disconnected: false, completed: false, faulted: false, queuedEvents: 65 }
  }), /Invalid/);
});

test("operator diagnostics parser accepts only bounded content-free managed WSS failure facts", () => {
  const snapshot: OperatorDiagnosticsSnapshot = {
    version: 1,
    source: "browser_handoff",
    health: "available",
    transport: {
      namespace: "managed_handoff",
      currentTransport: "websocket_relay",
      lastTransport: "websocket_relay",
      generation: 2,
      transitionCount: 1,
      lastFallbackReason: "transport_unavailable",
      wss: {
        namespace: "managed_wss",
        surfaceFailure: "frame_timeout",
        channelFailure: "none",
        framesObserved: 14,
        inputAttempts: 2,
        inputStage: "applied",
        inputBoundaryStage: "acknowledged"
      }
    }
  };
  assert.deepEqual(parseOperatorDiagnosticsSnapshot(snapshot), snapshot);
  assert.throws(() => parseOperatorDiagnosticsSnapshot({
    ...snapshot,
    transport: {
      ...snapshot.transport,
      wss: {
        ...(snapshot.transport.namespace === "managed_handoff" ? snapshot.transport.wss : {}),
        namespace: "managed_wss",
        surfaceFailure: "secret free-form failure"
      }
    }
  }), /Invalid/);
});
