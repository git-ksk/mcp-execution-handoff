export const MANAGED_OPERATOR_DIAGNOSTICS_SCHEMA_VERSION = 1;
export const MANAGED_OPERATOR_DIAGNOSTIC_EVENT_LIMIT = 64;
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
const EVENTS = new Set([
    "transport_transition", "wss_open", "wss_degraded", "wss_failed", "capture_recovery_attempt",
    "input_dispatch_failure", "helper_restart", "authority_boundary_lost", "session_retained", "session_revoked",
    "host_editable_regions_available", "host_editable_regions_empty", "host_focus_editable",
    "host_focus_not_editable", "host_successor_probe_started", "host_successor_admitted",
    "host_successor_returned", "host_successor_none", "host_successor_ambiguous",
    "host_successor_unsupported", "host_successor_failure", "client_editable_regions_available",
    "client_editable_regions_empty",
    "client_tap_editable_predicted", "client_tap_editable_not_predicted", "client_keyboard_focus_requested",
    "client_keyboard_focus_active", "client_keyboard_focus_inactive"
]);
function exactKeys(record, allowed) {
    return Object.keys(record).length === allowed.size && Object.keys(record).every((key) => allowed.has(key));
}
function boundedCount(value, max) {
    return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
}
/** Strict closed-world parser for the content-free managed takeover operator contract. */
export function parseManagedOperatorDiagnosticsSnapshot(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid managed operator diagnostics snapshot");
    const root = value;
    if (!exactKeys(root, ROOT_KEYS)
        || root.version !== 1
        || !SOURCES.has(root.source)
        || root.namespace !== "managed_handoff"
        || !HEALTH.has(root.health)
        || !TRANSPORT.has(root.currentTransport)
        || !TRANSPORT.has(root.previousTransport)
        || !boundedCount(root.generation, 1_000_000)
        || !boundedCount(root.transitionCount, 128)
        || !FALLBACK.has(root.fallbackReason)) {
        throw new Error("Invalid managed operator diagnostics snapshot");
    }
    if (!root.wss || typeof root.wss !== "object" || Array.isArray(root.wss))
        throw new Error("Invalid managed operator diagnostics snapshot");
    const wss = root.wss;
    if (!exactKeys(wss, WSS_KEYS)
        || wss.namespace !== "managed_wss"
        || !CHANNEL_STATE.has(wss.channelState)
        || !CHANNEL_FAILURE.has(wss.channelFailure)
        || !DISCONNECT.has(wss.disconnectKind)
        || !boundedCount(wss.framesObserved, 1_000_000)
        || !boundedCount(wss.framesSent, 1_000_000)
        || !boundedCount(wss.framesDropped, 1_000_000)
        || !SURFACE_FAILURE.has(wss.surfaceFailure)
        || !boundedCount(wss.inputAttempts, 1_000_000)
        || !INPUT_STAGE.has(wss.lastInputStage)
        || !INPUT_BOUNDARY.has(wss.lastInputBoundaryStage)
        || !HELPER_STOP.has(wss.helperStopReason)
        || !HELPER_CRASH_REASON.has(wss.helperCrashReason)
        || !HELPER_EXIT.has(wss.helperExitKind)
        || !HELPER_CRASH_CLASS.has(wss.helperCrashClass)
        || !HELPER_CRASH_ORIGIN.has(wss.helperCrashOrigin)
        || !HELPER_CRASH_ERROR.has(wss.helperCrashErrorKind)
        || !HELPER_CRASH_MESSAGE.has(wss.helperCrashMessageClass)
        || !AUTHORITY.has(wss.authorityBoundary)
        || !SESSION.has(wss.sessionDisposition)) {
        throw new Error("Invalid managed operator diagnostics snapshot");
    }
    if (!Array.isArray(root.events) || root.events.length > MANAGED_OPERATOR_DIAGNOSTIC_EVENT_LIMIT) {
        throw new Error("Invalid managed operator diagnostics snapshot");
    }
    const events = root.events.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item))
            throw new Error("Invalid managed operator diagnostics snapshot");
        const event = item;
        if (!exactKeys(event, EVENT_KEYS) || !EVENTS.has(event.kind)) {
            throw new Error("Invalid managed operator diagnostics snapshot");
        }
        return { kind: event.kind };
    });
    return {
        version: 1,
        source: root.source,
        namespace: "managed_handoff",
        health: root.health,
        currentTransport: root.currentTransport,
        previousTransport: root.previousTransport,
        generation: root.generation,
        transitionCount: root.transitionCount,
        fallbackReason: root.fallbackReason,
        wss: {
            namespace: "managed_wss",
            channelState: wss.channelState,
            channelFailure: wss.channelFailure,
            disconnectKind: wss.disconnectKind,
            framesObserved: wss.framesObserved,
            framesSent: wss.framesSent,
            framesDropped: wss.framesDropped,
            surfaceFailure: wss.surfaceFailure,
            inputAttempts: wss.inputAttempts,
            lastInputStage: wss.lastInputStage,
            lastInputBoundaryStage: wss.lastInputBoundaryStage,
            helperStopReason: wss.helperStopReason,
            helperCrashReason: wss.helperCrashReason,
            helperExitKind: wss.helperExitKind,
            helperCrashClass: wss.helperCrashClass,
            helperCrashOrigin: wss.helperCrashOrigin,
            helperCrashErrorKind: wss.helperCrashErrorKind,
            helperCrashMessageClass: wss.helperCrashMessageClass,
            authorityBoundary: wss.authorityBoundary,
            sessionDisposition: wss.sessionDisposition
        },
        events
    };
}
export class ManagedOperatorDiagnosticEvents {
    #events = [];
    #observer;
    constructor(observer) {
        this.#observer = observer;
    }
    record(kind) {
        const event = { kind };
        this.#events.push(event);
        if (this.#events.length > MANAGED_OPERATOR_DIAGNOSTIC_EVENT_LIMIT) {
            this.#events.splice(0, this.#events.length - MANAGED_OPERATOR_DIAGNOSTIC_EVENT_LIMIT);
        }
        try {
            this.#observer?.({ ...event });
        }
        catch { /* diagnostics are observe-only */ }
    }
    snapshot() { return this.#events.map((event) => ({ ...event })); }
}
/** Empty content-free managed snapshot for adapters running without managed fallback. */
export function emptyManagedOperatorDiagnosticsSnapshot(source) {
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
//# sourceMappingURL=managed-operator-diagnostics.js.map