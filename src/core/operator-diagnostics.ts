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
export type OperatorManagedTransportClass =
  | "webrtc_direct"
  | "websocket_relay"
  | "webrtc_relay"
  | "none";
export type OperatorManagedFallbackReason = "transport_unavailable";

export type OperatorManagedWssSurfaceFailure =
  | "none"
  | "frame_timeout"
  | "helper_closed"
  | "helper_error"
  | "frame_protocol"
  | "diagnostics_bounds"
  | "input_failure"
  | "input_timeout"
  | "input_revalidation_failure"
  | "revalidation_failure"
  | "capture_x11"
  | "capture_encoder"
  | "capture_option"
  | "capture_other";
export type OperatorManagedWssChannelFailure =
  | "none"
  | "invalid_message"
  | "input_not_allowed"
  | "stale_generation"
  | "frame_too_large"
  | "transport_failure"
  | "authority_release_failed";
export type OperatorManagedWssInputStage =
  | "none"
  | "focus_ready"
  | "pointer_move_ready"
  | "pointer_authority_ready"
  | "pointer_down_sent"
  | "pointer_post_authority_ready"
  | "tap_sent"
  | "key_down_sent"
  | "key_authority_ready"
  | "key_up_sent"
  | "applied";
export type OperatorManagedWssInputBoundaryStage =
  | "none"
  | "requested"
  | "helper_ready"
  | "revalidation_ready"
  | "command_sent"
  | "acknowledged";

export interface OperatorManagedWssDiagnostics {
  namespace: "managed_wss";
  surfaceFailure: OperatorManagedWssSurfaceFailure;
  channelFailure: OperatorManagedWssChannelFailure;
  framesObserved: number;
  inputAttempts: number;
  inputStage: OperatorManagedWssInputStage;
  inputBoundaryStage: OperatorManagedWssInputBoundaryStage;
}

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

export interface OperatorManagedHandoffTransportDiagnostics {
  namespace: "managed_handoff";
  currentTransport: OperatorManagedTransportClass;
  lastTransport: OperatorManagedTransportClass;
  generation: number;
  transitionCount: number;
  lastFallbackReason?: OperatorManagedFallbackReason;
  wss?: OperatorManagedWssDiagnostics;
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
      transport: OperatorWebRtcTransportDiagnostics | OperatorManagedHandoffTransportDiagnostics;
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
const MANAGED_KEYS = new Set([
  "namespace",
  "currentTransport",
  "lastTransport",
  "generation",
  "transitionCount",
  "lastFallbackReason",
  "wss"
]);
const MANAGED_WSS_KEYS = new Set([
  "namespace",
  "surfaceFailure",
  "channelFailure",
  "framesObserved",
  "inputAttempts",
  "inputStage",
  "inputBoundaryStage"
]);
const MANAGED_WSS_SURFACE_FAILURE = new Set<OperatorManagedWssSurfaceFailure>([
  "none", "frame_timeout", "helper_closed", "helper_error", "frame_protocol",
  "diagnostics_bounds", "input_failure", "input_timeout", "input_revalidation_failure",
  "revalidation_failure", "capture_x11", "capture_encoder", "capture_option", "capture_other"
]);
const MANAGED_WSS_CHANNEL_FAILURE = new Set<OperatorManagedWssChannelFailure>([
  "none", "invalid_message", "input_not_allowed", "stale_generation", "frame_too_large",
  "transport_failure", "authority_release_failed"
]);
const MANAGED_WSS_INPUT_STAGE = new Set<OperatorManagedWssInputStage>([
  "none", "focus_ready", "pointer_move_ready", "pointer_authority_ready", "pointer_down_sent",
  "pointer_post_authority_ready", "tap_sent", "key_down_sent", "key_authority_ready", "key_up_sent", "applied"
]);
const MANAGED_WSS_INPUT_BOUNDARY_STAGE = new Set<OperatorManagedWssInputBoundaryStage>([
  "none", "requested", "helper_ready", "revalidation_ready", "command_sent", "acknowledged"
]);
const TERMINAL_SESSION_KEYS = new Set(["namespace", "alive", "humanDisconnected", "synchronizationRequired"]);
const TERMINAL_KEYS = new Set(["namespace", "ready", "disconnected", "completed", "faulted", "queuedEvents"]);
const COUNT_KEYS = new Set(["host", "srflx", "prflx", "relay"]);
const HEALTH = new Set<OperatorDiagnosticsHealth>(["idle", "starting", "available", "degraded", "failed"]);
const FAILURE = new Set<OperatorDiagnosticsFailureCategory>(["target", "transport", "input", "recovery"]);
const PEER = new Set<OperatorDiagnosticsPeerState>(["new", "connecting", "connected", "disconnected", "failed", "closed"]);
const MANAGED_TRANSPORT = new Set<OperatorManagedTransportClass>([
  "webrtc_direct", "websocket_relay", "webrtc_relay", "none"
]);
const MANAGED_REASON = new Set<OperatorManagedFallbackReason>(["transport_unavailable"]);
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


function parseManagedWss(value: unknown): OperatorManagedWssDiagnostics | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid operator diagnostics snapshot");
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, MANAGED_WSS_KEYS)
    || Object.keys(record).length !== MANAGED_WSS_KEYS.size
    || record.namespace !== "managed_wss"
    || !MANAGED_WSS_SURFACE_FAILURE.has(record.surfaceFailure as OperatorManagedWssSurfaceFailure)
    || !MANAGED_WSS_CHANNEL_FAILURE.has(record.channelFailure as OperatorManagedWssChannelFailure)
    || !boundedInteger(record.framesObserved, 1_000_000)
    || !boundedInteger(record.inputAttempts, 1_000_000)
    || !MANAGED_WSS_INPUT_STAGE.has(record.inputStage as OperatorManagedWssInputStage)
    || !MANAGED_WSS_INPUT_BOUNDARY_STAGE.has(record.inputBoundaryStage as OperatorManagedWssInputBoundaryStage)) {
    throw new Error("Invalid operator diagnostics snapshot");
  }
  return {
    namespace: "managed_wss",
    surfaceFailure: record.surfaceFailure as OperatorManagedWssSurfaceFailure,
    channelFailure: record.channelFailure as OperatorManagedWssChannelFailure,
    framesObserved: record.framesObserved as number,
    inputAttempts: record.inputAttempts as number,
    inputStage: record.inputStage as OperatorManagedWssInputStage,
    inputBoundaryStage: record.inputBoundaryStage as OperatorManagedWssInputBoundaryStage
  };
}

function parseManagedTransport(value: unknown): OperatorManagedHandoffTransportDiagnostics {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid operator diagnostics snapshot");
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, MANAGED_KEYS)
    || record.namespace !== "managed_handoff"
    || !MANAGED_TRANSPORT.has(record.currentTransport as OperatorManagedTransportClass)
    || !MANAGED_TRANSPORT.has(record.lastTransport as OperatorManagedTransportClass)
    || !boundedInteger(record.generation, 1_000_000)
    || !boundedInteger(record.transitionCount, 128)
    || (record.lastFallbackReason !== undefined
      && !MANAGED_REASON.has(record.lastFallbackReason as OperatorManagedFallbackReason))) {
    throw new Error("Invalid operator diagnostics snapshot");
  }
  const wss = parseManagedWss(record.wss);
  return {
    namespace: "managed_handoff",
    currentTransport: record.currentTransport as OperatorManagedTransportClass,
    lastTransport: record.lastTransport as OperatorManagedTransportClass,
    generation: record.generation as number,
    transitionCount: record.transitionCount as number,
    ...(record.lastFallbackReason === undefined
      ? {}
      : { lastFallbackReason: record.lastFallbackReason as OperatorManagedFallbackReason }),
    ...(wss ? { wss } : {})
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
    const transportRecord = record.transport && typeof record.transport === "object" && !Array.isArray(record.transport)
      ? record.transport as Record<string, unknown>
      : undefined;
    const transport = transportRecord?.namespace === "managed_handoff"
      ? parseManagedTransport(record.transport)
      : parseWebRtcTransport(record.transport);
    return {
      version: 1,
      source: record.source,
      health: record.health as OperatorDiagnosticsHealth,
      ...(record.failureCategory === undefined ? {} : { failureCategory: record.failureCategory as OperatorDiagnosticsFailureCategory }),
      transport
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
