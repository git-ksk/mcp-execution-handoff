import type { OperatorDiagnosticsHealth, OperatorDiagnosticsSource } from "../core/operator-diagnostics.js";
import type { ManagedBrowserHandoffFallbackReason } from "./managed-transport-coordinator.js";
import type { BrowserHandoffTransportAttempt } from "./transport-fallback-policy.js";
import type {
  ExperimentalWebSocketIngressDisconnectKind
} from "./websocket-ingress.js";
import type {
  WebSocketTakeoverFailureCode,
  WebSocketTakeoverState
} from "./websocket-takeover.js";
import type {
  LinuxWebSocketHelperCrashClass,
  LinuxWebSocketHelperCrashErrorKind,
  LinuxWebSocketHelperCrashMessageClass,
  LinuxWebSocketHelperCrashOrigin,
  LinuxWebSocketHelperCrashReason,
  LinuxWebSocketHelperExitKind,
  LinuxWebSocketHelperStopReason,
  LinuxWebSocketInputBoundaryStage,
  LinuxWebSocketInputStage,
  LinuxWebSocketSurfaceFailure
} from "./linux-websocket-window-surface.js";

export const MANAGED_OPERATOR_DIAGNOSTICS_SCHEMA_VERSION = 1 as const;
export const MANAGED_OPERATOR_DIAGNOSTIC_EVENT_LIMIT = 64 as const;

export type ManagedOperatorDiagnosticEventKind =
  | "transport_transition"
  | "wss_open"
  | "wss_degraded"
  | "wss_failed"
  | "capture_recovery_attempt"
  | "input_dispatch_failure"
  | "helper_restart"
  | "authority_boundary_lost"
  | "session_retained"
  | "session_revoked";

export interface ManagedOperatorDiagnosticEvent {
  kind: ManagedOperatorDiagnosticEventKind;
}

export type ManagedOperatorAuthorityBoundary = "valid" | "lost";
export type ManagedOperatorSessionDisposition = "none" | "retained" | "revoked";
export type ManagedOperatorTransport = BrowserHandoffTransportAttempt | "none";
export type ManagedOperatorWssChannelState = WebSocketTakeoverState | "none";
export type ManagedOperatorWssFailureCode = WebSocketTakeoverFailureCode | "none";
export type ManagedOperatorWssDisconnectKind = ExperimentalWebSocketIngressDisconnectKind;
export type ManagedOperatorFallbackReason = ManagedBrowserHandoffFallbackReason | "none";

export interface ManagedOperatorWssDiagnostics {
  namespace: "managed_wss";
  channelState: ManagedOperatorWssChannelState;
  channelFailure: ManagedOperatorWssFailureCode;
  disconnectKind: ManagedOperatorWssDisconnectKind;
  framesObserved: number;
  framesSent: number;
  framesDropped: number;
  surfaceFailure: LinuxWebSocketSurfaceFailure;
  inputAttempts: number;
  lastInputStage: LinuxWebSocketInputStage;
  lastInputBoundaryStage: LinuxWebSocketInputBoundaryStage;
  helperStopReason: LinuxWebSocketHelperStopReason;
  helperCrashReason: LinuxWebSocketHelperCrashReason;
  helperExitKind: LinuxWebSocketHelperExitKind;
  helperCrashClass: LinuxWebSocketHelperCrashClass;
  helperCrashOrigin: LinuxWebSocketHelperCrashOrigin;
  helperCrashErrorKind: LinuxWebSocketHelperCrashErrorKind;
  helperCrashMessageClass: LinuxWebSocketHelperCrashMessageClass;
  authorityBoundary: ManagedOperatorAuthorityBoundary;
  sessionDisposition: ManagedOperatorSessionDisposition;
}

export interface ManagedOperatorDiagnosticsSnapshot {
  version: typeof MANAGED_OPERATOR_DIAGNOSTICS_SCHEMA_VERSION;
  source: Extract<OperatorDiagnosticsSource, "browser_handoff" | "window_handoff">;
  namespace: "managed_handoff";
  health: OperatorDiagnosticsHealth;
  currentTransport: ManagedOperatorTransport;
  previousTransport: ManagedOperatorTransport;
  generation: number;
  transitionCount: number;
  fallbackReason: ManagedOperatorFallbackReason;
  wss: ManagedOperatorWssDiagnostics;
  events: ManagedOperatorDiagnosticEvent[];
}

const ROOT_KEYS = new Set([
  "version", "source", "namespace", "health", "currentTransport", "previousTransport",
  "generation", "transitionCount", "fallbackReason", "wss", "events"
]);
const WSS_KEYS = new Set([
  "namespace", "channelState", "channelFailure", "disconnectKind", "framesObserved", "framesSent",
  "framesDropped", "surfaceFailure", "inputAttempts", "lastInputStage", "lastInputBoundaryStage",
  "helperStopReason", "helperCrashReason", "helperExitKind", "helperCrashClass", "helperCrashOrigin",
  "helperCrashErrorKind", "helperCrashMessageClass", "authorityBoundary", "sessionDisposition"
]);
const EVENT_KEYS = new Set(["kind"]);
const SOURCES = new Set(["browser_handoff", "window_handoff"]);
const HEALTH = new Set(["idle", "starting", "available", "degraded", "failed"]);
const TRANSPORT = new Set(["webrtc_direct", "websocket_relay", "webrtc_relay", "none"]);
const FALLBACK = new Set(["none", "transport_unavailable"]);
const CHANNEL_STATE = new Set(["none", "open", "closing", "closed", "revoked", "failed"]);
const CHANNEL_FAILURE = new Set([
  "none", "invalid_message", "input_not_allowed", "stale_generation", "frame_too_large",
  "transport_failure", "authority_release_failed"
]);
const DISCONNECT = new Set(["none", "peer_close", "peer_error", "policy_close", "channel_failure"]);
const SURFACE_FAILURE = new Set([
  "none", "frame_timeout", "helper_closed", "helper_error", "frame_protocol", "diagnostics_bounds",
  "input_failure", "input_timeout", "input_revalidation_failure", "revalidation_failure", "capture_x11",
  "capture_encoder", "capture_option", "capture_other"
]);
const INPUT_STAGE = new Set([
  "none", "focus_ready", "pointer_move_ready", "pointer_authority_ready", "pointer_down_sent",
  "pointer_post_authority_ready", "tap_sent", "key_down_sent", "key_authority_ready", "key_up_sent", "applied"
]);
const INPUT_BOUNDARY = new Set(["none", "requested", "helper_ready", "revalidation_ready", "command_sent", "acknowledged"]);
const HELPER_STOP = new Set(["none", "capture_failure", "input_failure", "stdin_end", "signal_term", "signal_int", "expiry", "input_buffer_bounds", "explicit_stop"]);
const HELPER_CRASH_REASON = new Set(["none", "uncaught_exception", "main_rejection"]);
const HELPER_EXIT = new Set(["none", "clean", "nonzero", "signal"]);
const HELPER_CRASH_CLASS = new Set([
  "none", "pipe_epipe", "stream_write_after_end", "stream_destroyed", "jpeg_parser", "frame_writer",
  "input_callback", "xtest_callback", "accessibility_callback", "capture_callback", "stream_internal",
  "event_dispatch", "child_process_internal", "special_key", "exact_window_revalidate", "active_target_check",
  "focus_target_check", "scroll_input", "text_input", "host_input_apply", "host_input_chain", "host_module", "unknown"
]);
const HELPER_CRASH_ORIGIN = new Set(["none", "uncaught_exception", "unhandled_rejection", "unknown"]);
const HELPER_CRASH_ERROR = new Set(["none", "error", "type_error", "range_error", "other"]);
const HELPER_CRASH_MESSAGE = new Set([
  "none", "focus_not_owned", "window_not_active", "target_process_unavailable", "window_not_visible",
  "window_owner_changed", "window_geometry_unavailable", "special_key_geometry_changed", "xtest_helper_unavailable",
  "xtest_helper_busy", "xtest_helper_ack_timeout", "xtest_helper_rejected", "atspi_unavailable", "atspi_busy",
  "atspi_timeout", "atspi_readiness_timeout", "atspi_response_failed", "atspi_response_invalid", "atspi_response_large",
  "atspi_regions_many", "atspi_region_invalid", "atspi_region_bounds", "atspi_write_failure", "atspi_output_bounds",
  "atspi_protocol_mismatch", "atspi_unexpected_response", "atspi_process_failed", "atspi_process_closed", "atspi_failed",
  "helper_command_timeout", "helper_command_failed", "other"
]);
const AUTHORITY = new Set(["valid", "lost"]);
const SESSION = new Set(["none", "retained", "revoked"]);
const EVENTS = new Set<ManagedOperatorDiagnosticEventKind>([
  "transport_transition", "wss_open", "wss_degraded", "wss_failed", "capture_recovery_attempt",
  "input_dispatch_failure", "helper_restart", "authority_boundary_lost", "session_retained", "session_revoked"
]);

function exactKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).length === allowed.size && Object.keys(record).every((key) => allowed.has(key));
}

function boundedCount(value: unknown, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
}

/** Strict closed-world parser for the content-free managed takeover operator contract. */
export function parseManagedOperatorDiagnosticsSnapshot(value: unknown): ManagedOperatorDiagnosticsSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid managed operator diagnostics snapshot");
  const root = value as Record<string, unknown>;
  if (!exactKeys(root, ROOT_KEYS)
    || root.version !== 1
    || !SOURCES.has(root.source as string)
    || root.namespace !== "managed_handoff"
    || !HEALTH.has(root.health as string)
    || !TRANSPORT.has(root.currentTransport as string)
    || !TRANSPORT.has(root.previousTransport as string)
    || !boundedCount(root.generation, 1_000_000)
    || !boundedCount(root.transitionCount, 128)
    || !FALLBACK.has(root.fallbackReason as string)) {
    throw new Error("Invalid managed operator diagnostics snapshot");
  }
  if (!root.wss || typeof root.wss !== "object" || Array.isArray(root.wss)) throw new Error("Invalid managed operator diagnostics snapshot");
  const wss = root.wss as Record<string, unknown>;
  if (!exactKeys(wss, WSS_KEYS)
    || wss.namespace !== "managed_wss"
    || !CHANNEL_STATE.has(wss.channelState as string)
    || !CHANNEL_FAILURE.has(wss.channelFailure as string)
    || !DISCONNECT.has(wss.disconnectKind as string)
    || !boundedCount(wss.framesObserved, 1_000_000)
    || !boundedCount(wss.framesSent, 1_000_000)
    || !boundedCount(wss.framesDropped, 1_000_000)
    || !SURFACE_FAILURE.has(wss.surfaceFailure as string)
    || !boundedCount(wss.inputAttempts, 1_000_000)
    || !INPUT_STAGE.has(wss.lastInputStage as string)
    || !INPUT_BOUNDARY.has(wss.lastInputBoundaryStage as string)
    || !HELPER_STOP.has(wss.helperStopReason as string)
    || !HELPER_CRASH_REASON.has(wss.helperCrashReason as string)
    || !HELPER_EXIT.has(wss.helperExitKind as string)
    || !HELPER_CRASH_CLASS.has(wss.helperCrashClass as string)
    || !HELPER_CRASH_ORIGIN.has(wss.helperCrashOrigin as string)
    || !HELPER_CRASH_ERROR.has(wss.helperCrashErrorKind as string)
    || !HELPER_CRASH_MESSAGE.has(wss.helperCrashMessageClass as string)
    || !AUTHORITY.has(wss.authorityBoundary as string)
    || !SESSION.has(wss.sessionDisposition as string)) {
    throw new Error("Invalid managed operator diagnostics snapshot");
  }
  if (!Array.isArray(root.events) || root.events.length > MANAGED_OPERATOR_DIAGNOSTIC_EVENT_LIMIT) {
    throw new Error("Invalid managed operator diagnostics snapshot");
  }
  const events = root.events.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid managed operator diagnostics snapshot");
    const event = item as Record<string, unknown>;
    if (!exactKeys(event, EVENT_KEYS) || !EVENTS.has(event.kind as ManagedOperatorDiagnosticEventKind)) {
      throw new Error("Invalid managed operator diagnostics snapshot");
    }
    return { kind: event.kind as ManagedOperatorDiagnosticEventKind };
  });
  return {
    version: 1,
    source: root.source as ManagedOperatorDiagnosticsSnapshot["source"],
    namespace: "managed_handoff",
    health: root.health as OperatorDiagnosticsHealth,
    currentTransport: root.currentTransport as ManagedOperatorTransport,
    previousTransport: root.previousTransport as ManagedOperatorTransport,
    generation: root.generation as number,
    transitionCount: root.transitionCount as number,
    fallbackReason: root.fallbackReason as ManagedOperatorFallbackReason,
    wss: {
      namespace: "managed_wss",
      channelState: wss.channelState as ManagedOperatorWssChannelState,
      channelFailure: wss.channelFailure as ManagedOperatorWssFailureCode,
      disconnectKind: wss.disconnectKind as ManagedOperatorWssDisconnectKind,
      framesObserved: wss.framesObserved as number,
      framesSent: wss.framesSent as number,
      framesDropped: wss.framesDropped as number,
      surfaceFailure: wss.surfaceFailure as LinuxWebSocketSurfaceFailure,
      inputAttempts: wss.inputAttempts as number,
      lastInputStage: wss.lastInputStage as LinuxWebSocketInputStage,
      lastInputBoundaryStage: wss.lastInputBoundaryStage as LinuxWebSocketInputBoundaryStage,
      helperStopReason: wss.helperStopReason as LinuxWebSocketHelperStopReason,
      helperCrashReason: wss.helperCrashReason as LinuxWebSocketHelperCrashReason,
      helperExitKind: wss.helperExitKind as LinuxWebSocketHelperExitKind,
      helperCrashClass: wss.helperCrashClass as LinuxWebSocketHelperCrashClass,
      helperCrashOrigin: wss.helperCrashOrigin as LinuxWebSocketHelperCrashOrigin,
      helperCrashErrorKind: wss.helperCrashErrorKind as LinuxWebSocketHelperCrashErrorKind,
      helperCrashMessageClass: wss.helperCrashMessageClass as LinuxWebSocketHelperCrashMessageClass,
      authorityBoundary: wss.authorityBoundary as ManagedOperatorAuthorityBoundary,
      sessionDisposition: wss.sessionDisposition as ManagedOperatorSessionDisposition
    },
    events
  };
}

export class ManagedOperatorDiagnosticEvents {
  readonly #events: ManagedOperatorDiagnosticEvent[] = [];
  record(kind: ManagedOperatorDiagnosticEventKind): void {
    this.#events.push({ kind });
    if (this.#events.length > MANAGED_OPERATOR_DIAGNOSTIC_EVENT_LIMIT) {
      this.#events.splice(0, this.#events.length - MANAGED_OPERATOR_DIAGNOSTIC_EVENT_LIMIT);
    }
  }
  snapshot(): ManagedOperatorDiagnosticEvent[] { return this.#events.map((event) => ({ ...event })); }
}

/** Empty content-free managed snapshot for adapters running without managed fallback. */
export function emptyManagedOperatorDiagnosticsSnapshot(
  source: ManagedOperatorDiagnosticsSnapshot["source"]
): ManagedOperatorDiagnosticsSnapshot {
  return {
    version: 1,
    source,
    namespace: "managed_handoff",
    health: "idle",
    currentTransport: "none",
    previousTransport: "none",
    generation: 0,
    transitionCount: 0,
    fallbackReason: "none",
    wss: {
      namespace: "managed_wss",
      channelState: "none",
      channelFailure: "none",
      disconnectKind: "none",
      framesObserved: 0,
      framesSent: 0,
      framesDropped: 0,
      surfaceFailure: "none",
      inputAttempts: 0,
      lastInputStage: "none",
      lastInputBoundaryStage: "none",
      helperStopReason: "none",
      helperCrashReason: "none",
      helperExitKind: "none",
      helperCrashClass: "none",
      helperCrashOrigin: "none",
      helperCrashErrorKind: "none",
      helperCrashMessageClass: "none",
      authorityBoundary: "valid",
      sessionDisposition: "none"
    },
    events: []
  };
}
