export const OPERATOR_DIAGNOSTICS_SCHEMA_VERSION = 1;
export const OPERATOR_DIAGNOSTICS_SOURCES = [
    "browser_handoff",
    "window_handoff",
    "terminal_handoff"
];
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
const MANAGED_WSS_SURFACE_FAILURE = new Set([
    "none", "frame_timeout", "helper_closed", "helper_error", "frame_protocol",
    "diagnostics_bounds", "input_failure", "input_timeout", "input_revalidation_failure",
    "revalidation_failure", "capture_x11", "capture_encoder", "capture_option", "capture_other"
]);
const MANAGED_WSS_CHANNEL_FAILURE = new Set([
    "none", "invalid_message", "input_not_allowed", "stale_generation", "frame_too_large",
    "transport_failure", "authority_release_failed"
]);
const MANAGED_WSS_INPUT_STAGE = new Set([
    "none", "focus_ready", "pointer_move_ready", "pointer_authority_ready", "pointer_down_sent",
    "pointer_post_authority_ready", "tap_sent", "key_down_sent", "key_authority_ready", "key_up_sent", "applied"
]);
const MANAGED_WSS_INPUT_BOUNDARY_STAGE = new Set([
    "none", "requested", "helper_ready", "revalidation_ready", "command_sent", "acknowledged"
]);
const TERMINAL_SESSION_KEYS = new Set(["namespace", "alive", "humanDisconnected", "synchronizationRequired"]);
const TERMINAL_KEYS = new Set(["namespace", "ready", "disconnected", "completed", "faulted", "queuedEvents"]);
const COUNT_KEYS = new Set(["host", "srflx", "prflx", "relay"]);
const HEALTH = new Set(["idle", "starting", "available", "degraded", "failed"]);
const FAILURE = new Set(["target", "transport", "input", "recovery"]);
const PEER = new Set(["new", "connecting", "connected", "disconnected", "failed", "closed"]);
const MANAGED_TRANSPORT = new Set([
    "webrtc_direct", "websocket_relay", "webrtc_relay", "none"
]);
const MANAGED_REASON = new Set(["transport_unavailable"]);
const AUTHORITY = new Set(["agent", "human", "none"]);
const PHASE = new Set(["awaiting_human", "human_active", "verifying", "ready_to_resume"]);
function exactKeys(record, allowed) {
    return Object.keys(record).every((key) => allowed.has(key));
}
function boundedInteger(value, max) {
    return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
}
function parseCounts(value) {
    if (value === undefined)
        return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid operator diagnostics snapshot");
    const record = value;
    if (!exactKeys(record, COUNT_KEYS) || Object.keys(record).length !== COUNT_KEYS.size)
        throw new Error("Invalid operator diagnostics snapshot");
    for (const key of COUNT_KEYS)
        if (!boundedInteger(record[key], 64))
            throw new Error("Invalid operator diagnostics snapshot");
    return {
        host: record.host,
        srflx: record.srflx,
        prflx: record.prflx,
        relay: record.relay
    };
}
function parseWebRtcTransport(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid operator diagnostics snapshot");
    const record = value;
    if (!exactKeys(record, WEBRTC_KEYS)
        || record.namespace !== "webrtc"
        || !boundedInteger(record.eventCount, 128)
        || (record.peerState !== undefined && !PEER.has(record.peerState))) {
        throw new Error("Invalid operator diagnostics snapshot");
    }
    const candidateCounts = parseCounts(record.candidateCounts);
    return {
        namespace: "webrtc",
        eventCount: record.eventCount,
        ...(record.peerState === undefined ? {} : { peerState: record.peerState }),
        ...(candidateCounts ? { candidateCounts } : {})
    };
}
function parseManagedWss(value) {
    if (value === undefined)
        return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid operator diagnostics snapshot");
    const record = value;
    if (!exactKeys(record, MANAGED_WSS_KEYS)
        || Object.keys(record).length !== MANAGED_WSS_KEYS.size
        || record.namespace !== "managed_wss"
        || !MANAGED_WSS_SURFACE_FAILURE.has(record.surfaceFailure)
        || !MANAGED_WSS_CHANNEL_FAILURE.has(record.channelFailure)
        || !boundedInteger(record.framesObserved, 1_000_000)
        || !boundedInteger(record.inputAttempts, 1_000_000)
        || !MANAGED_WSS_INPUT_STAGE.has(record.inputStage)
        || !MANAGED_WSS_INPUT_BOUNDARY_STAGE.has(record.inputBoundaryStage)) {
        throw new Error("Invalid operator diagnostics snapshot");
    }
    return {
        namespace: "managed_wss",
        surfaceFailure: record.surfaceFailure,
        channelFailure: record.channelFailure,
        framesObserved: record.framesObserved,
        inputAttempts: record.inputAttempts,
        inputStage: record.inputStage,
        inputBoundaryStage: record.inputBoundaryStage
    };
}
function parseManagedTransport(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid operator diagnostics snapshot");
    const record = value;
    if (!exactKeys(record, MANAGED_KEYS)
        || record.namespace !== "managed_handoff"
        || !MANAGED_TRANSPORT.has(record.currentTransport)
        || !MANAGED_TRANSPORT.has(record.lastTransport)
        || !boundedInteger(record.generation, 1_000_000)
        || !boundedInteger(record.transitionCount, 128)
        || (record.lastFallbackReason !== undefined
            && !MANAGED_REASON.has(record.lastFallbackReason))) {
        throw new Error("Invalid operator diagnostics snapshot");
    }
    const wss = parseManagedWss(record.wss);
    return {
        namespace: "managed_handoff",
        currentTransport: record.currentTransport,
        lastTransport: record.lastTransport,
        generation: record.generation,
        transitionCount: record.transitionCount,
        ...(record.lastFallbackReason === undefined
            ? {}
            : { lastFallbackReason: record.lastFallbackReason }),
        ...(wss ? { wss } : {})
    };
}
function parseTerminalSession(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid operator diagnostics snapshot");
    const record = value;
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
function parseTerminalTransport(value) {
    if (value === null)
        return null;
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid operator diagnostics snapshot");
    const record = value;
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
        queuedEvents: record.queuedEvents
    };
}
/**
 * Strict parser for the stable process-memory operator summary. It intentionally has no generic
 * identifier, payload, timestamp, message, target identity, or recovery-authority field.
 */
export function parseOperatorDiagnosticsSnapshot(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid operator diagnostics snapshot");
    const record = value;
    if (record.version !== OPERATOR_DIAGNOSTICS_SCHEMA_VERSION
        || !OPERATOR_DIAGNOSTICS_SOURCES.includes(record.source)
        || !HEALTH.has(record.health)
        || (record.failureCategory !== undefined && !FAILURE.has(record.failureCategory))) {
        throw new Error("Invalid operator diagnostics snapshot");
    }
    if (record.source === "browser_handoff" || record.source === "window_handoff") {
        if (!exactKeys(record, ROOT_WEBRTC_KEYS))
            throw new Error("Invalid operator diagnostics snapshot");
        const transportRecord = record.transport && typeof record.transport === "object" && !Array.isArray(record.transport)
            ? record.transport
            : undefined;
        const transport = transportRecord?.namespace === "managed_handoff"
            ? parseManagedTransport(record.transport)
            : parseWebRtcTransport(record.transport);
        return {
            version: 1,
            source: record.source,
            health: record.health,
            ...(record.failureCategory === undefined ? {} : { failureCategory: record.failureCategory }),
            transport
        };
    }
    if (!exactKeys(record, ROOT_TERMINAL_KEYS)
        || !AUTHORITY.has(record.authority)
        || (record.phase !== undefined && !PHASE.has(record.phase))) {
        throw new Error("Invalid operator diagnostics snapshot");
    }
    return {
        version: 1,
        source: "terminal_handoff",
        health: record.health,
        authority: record.authority,
        ...(record.phase === undefined ? {} : { phase: record.phase }),
        ...(record.failureCategory === undefined ? {} : { failureCategory: record.failureCategory }),
        terminal: parseTerminalSession(record.terminal),
        transport: parseTerminalTransport(record.transport)
    };
}
//# sourceMappingURL=operator-diagnostics.js.map