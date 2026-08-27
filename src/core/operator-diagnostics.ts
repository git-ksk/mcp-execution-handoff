import type { ExecutionAuthority, InterventionStatus } from "./lifecycle.js";

export const OPERATOR_DIAGNOSTICS_SCHEMA_VERSION = 1 as const;
export const OPERATOR_DIAGNOSTICS_SOURCES = [
  "browser_handoff",
  "window_handoff",
  "terminal_handoff"
] as const;
export type OperatorDiagnosticsSource = (typeof OPERATOR_DIAGNOSTICS_SOURCES)[number];
export type OperatorDiagnosticsHealth = "idle" | "starting" | "available" | "degraded" | "failed";
export type OperatorDiagnosticsFailureCategory = "target" | "transport" | "input" | "recovery";
export type OperatorDiagnosticsPeerState = "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed";

export interface OperatorDiagnosticsCandidateCounts {
  host: number;
  srflx: number;
  prflx: number;
  relay: number;
}

export interface OperatorWebRtcTransportDiagnostics {
  namespace: "webrtc";
  eventCount: number;
  peerState?: OperatorDiagnosticsPeerState;
  candidateCounts?: OperatorDiagnosticsCandidateCounts;
}

export interface OperatorTerminalSessionDiagnostics {
  namespace: "terminal_session";
  alive: boolean;
  humanDisconnected: boolean;
  synchronizationRequired: boolean;
}

export interface OperatorTerminalTransportDiagnostics {
  namespace: "terminal_webrtc";
  ready: boolean;
  disconnected: boolean;
  completed: boolean;
  faulted: boolean;
  queuedEvents: number;
}

export type OperatorDiagnosticsSnapshot =
  | {
      version: typeof OPERATOR_DIAGNOSTICS_SCHEMA_VERSION;
      source: "browser_handoff" | "window_handoff";
      health: OperatorDiagnosticsHealth;
      failureCategory?: OperatorDiagnosticsFailureCategory;
      transport: OperatorWebRtcTransportDiagnostics;
    }
  | {
      version: typeof OPERATOR_DIAGNOSTICS_SCHEMA_VERSION;
      source: "terminal_handoff";
      health: OperatorDiagnosticsHealth;
      authority: ExecutionAuthority;
      phase?: InterventionStatus;
      failureCategory?: OperatorDiagnosticsFailureCategory;
      terminal: OperatorTerminalSessionDiagnostics;
      transport: OperatorTerminalTransportDiagnostics | null;
    };

const ROOT_WEBRTC_KEYS = new Set(["version", "source", "health", "failureCategory", "transport"]);
const ROOT_TERMINAL_KEYS = new Set(["version", "source", "health", "authority", "phase", "failureCategory", "terminal", "transport"]);
const WEBRTC_KEYS = new Set(["namespace", "eventCount", "peerState", "candidateCounts"]);
const TERMINAL_SESSION_KEYS = new Set(["namespace", "alive", "humanDisconnected", "synchronizationRequired"]);
const TERMINAL_KEYS = new Set(["namespace", "ready", "disconnected", "completed", "faulted", "queuedEvents"]);
const COUNT_KEYS = new Set(["host", "srflx", "prflx", "relay"]);
const HEALTH = new Set<OperatorDiagnosticsHealth>(["idle", "starting", "available", "degraded", "failed"]);
const FAILURE = new Set<OperatorDiagnosticsFailureCategory>(["target", "transport", "input", "recovery"]);
const PEER = new Set<OperatorDiagnosticsPeerState>(["new", "connecting", "connected", "disconnected", "failed", "closed"]);
const AUTHORITY = new Set<ExecutionAuthority>(["agent", "human", "none"]);
const PHASE = new Set<InterventionStatus>(["awaiting_human", "human_active", "verifying", "ready_to_resume"]);

function exactKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function boundedInteger(value: unknown, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
}

function parseCounts(value: unknown): OperatorDiagnosticsCandidateCounts | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid operator diagnostics snapshot");
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, COUNT_KEYS) || Object.keys(record).length !== COUNT_KEYS.size) throw new Error("Invalid operator diagnostics snapshot");
  for (const key of COUNT_KEYS) if (!boundedInteger(record[key], 64)) throw new Error("Invalid operator diagnostics snapshot");
  return {
    host: record.host as number,
    srflx: record.srflx as number,
    prflx: record.prflx as number,
    relay: record.relay as number
  };
}

function parseWebRtcTransport(value: unknown): OperatorWebRtcTransportDiagnostics {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid operator diagnostics snapshot");
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, WEBRTC_KEYS)
    || record.namespace !== "webrtc"
    || !boundedInteger(record.eventCount, 128)
    || (record.peerState !== undefined && !PEER.has(record.peerState as OperatorDiagnosticsPeerState))) {
    throw new Error("Invalid operator diagnostics snapshot");
  }
  const candidateCounts = parseCounts(record.candidateCounts);
  return {
    namespace: "webrtc",
    eventCount: record.eventCount as number,
    ...(record.peerState === undefined ? {} : { peerState: record.peerState as OperatorDiagnosticsPeerState }),
    ...(candidateCounts ? { candidateCounts } : {})
  };
}


function parseTerminalSession(value: unknown): OperatorTerminalSessionDiagnostics {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid operator diagnostics snapshot");
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, TERMINAL_SESSION_KEYS)
    || record.namespace !== "terminal_session"
    || typeof record.alive !== "boolean"
    || typeof record.humanDisconnected !== "boolean"
    || typeof record.synchronizationRequired !== "boolean") {
    throw new Error("Invalid operator diagnostics snapshot");
  }
  return {
    namespace: "terminal_session",
    alive: record.alive,
    humanDisconnected: record.humanDisconnected,
    synchronizationRequired: record.synchronizationRequired
  };
}

function parseTerminalTransport(value: unknown): OperatorTerminalTransportDiagnostics | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid operator diagnostics snapshot");
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, TERMINAL_KEYS)
    || record.namespace !== "terminal_webrtc"
    || typeof record.ready !== "boolean"
    || typeof record.disconnected !== "boolean"
    || typeof record.completed !== "boolean"
    || typeof record.faulted !== "boolean"
    || !boundedInteger(record.queuedEvents, 64)) {
    throw new Error("Invalid operator diagnostics snapshot");
  }
  return {
    namespace: "terminal_webrtc",
    ready: record.ready,
    disconnected: record.disconnected,
    completed: record.completed,
    faulted: record.faulted,
    queuedEvents: record.queuedEvents as number
  };
}

/**
 * Strict parser for the stable process-memory operator summary. It intentionally has no generic
 * identifier, payload, timestamp, message, target identity, or recovery-authority field.
 */
export function parseOperatorDiagnosticsSnapshot(value: unknown): OperatorDiagnosticsSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid operator diagnostics snapshot");
  const record = value as Record<string, unknown>;
  if (record.version !== OPERATOR_DIAGNOSTICS_SCHEMA_VERSION
    || !OPERATOR_DIAGNOSTICS_SOURCES.includes(record.source as OperatorDiagnosticsSource)
    || !HEALTH.has(record.health as OperatorDiagnosticsHealth)
    || (record.failureCategory !== undefined && !FAILURE.has(record.failureCategory as OperatorDiagnosticsFailureCategory))) {
    throw new Error("Invalid operator diagnostics snapshot");
  }

  if (record.source === "browser_handoff" || record.source === "window_handoff") {
    if (!exactKeys(record, ROOT_WEBRTC_KEYS)) throw new Error("Invalid operator diagnostics snapshot");
    return {
      version: 1,
      source: record.source,
      health: record.health as OperatorDiagnosticsHealth,
      ...(record.failureCategory === undefined ? {} : { failureCategory: record.failureCategory as OperatorDiagnosticsFailureCategory }),
      transport: parseWebRtcTransport(record.transport)
    };
  }

  if (!exactKeys(record, ROOT_TERMINAL_KEYS)
    || !AUTHORITY.has(record.authority as ExecutionAuthority)
    || (record.phase !== undefined && !PHASE.has(record.phase as InterventionStatus))) {
    throw new Error("Invalid operator diagnostics snapshot");
  }
  return {
    version: 1,
    source: "terminal_handoff",
    health: record.health as OperatorDiagnosticsHealth,
    authority: record.authority as ExecutionAuthority,
    ...(record.phase === undefined ? {} : { phase: record.phase as InterventionStatus }),
    ...(record.failureCategory === undefined ? {} : { failureCategory: record.failureCategory as OperatorDiagnosticsFailureCategory }),
    terminal: parseTerminalSession(record.terminal),
    transport: parseTerminalTransport(record.transport)
  };
}
