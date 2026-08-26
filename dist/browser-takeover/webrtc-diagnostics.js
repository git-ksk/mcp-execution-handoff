const MAX_EVENTS = 128;
const MAX_CANDIDATES_PER_TYPE = 64;
const MAX_DURATION_MS = 120_000;
const BROWSER_STAGES = new Set([
    "browser.gather.complete",
    "browser.peer.state"
]);
const RELAY_FAILURE_REASONS = new Set([
    "generation_expired", "provider_auth", "provider_rate_limited", "provider_rejected",
    "provider_unavailable", "response_invalid", "unknown"
]);
const PEER_STATES = new Set([
    "new", "connecting", "connected", "disconnected", "failed", "closed"
]);
const ALL_STAGES = new Set([
    "broker.prepare.request",
    "broker.prepare.success",
    "broker.prepare.failure",
    "relay.credential.unavailable",
    "browser.gather.complete",
    "browser.peer.state",
    "broker.connect.request",
    "server.answer.ready",
    "broker.connect.success",
    "broker.connect.failure",
    "server.peer.state",
    "host.target.alive",
    "host.target.missing",
    "host.window.ready",
    "host.window.failure.none",
    "host.window.failure.multiple",
    "host.capture.started",
    "host.frame.ready",
    "host.input.focus.ready",
    "host.input.tap.sent",
    "host.input.pointer.helper_ready",
    "host.input.pointer.helper_failure",
    "host.input.pointer.move_ready",
    "host.input.pointer.authority_ready",
    "host.input.pointer.down_sent",
    "host.input.text.native_ax",
    "host.input.text.pid_keyboard",
    "host.input.text.event_creation_failure",
    "host.input.text.activation_rejected",
    "host.input.text.native_boundary_rejected",
    "host.input.failure",
    "host.capture.failure",
    "host.capture.failure.x11",
    "host.capture.failure.encoder",
    "host.capture.failure.option",
    "host.capture.failure.other"
]);
/**
 * Bounded process-memory-only WebRTC setup diagnostics.
 *
 * Events intentionally contain no session/client/principal identifiers, candidate strings, IPs,
 * SDP, SSRCs, credentials, media, or Human input. Callers should take a snapshot around one
 * disposable acceptance run when they need per-run attribution.
 */
export class WebRtcDiagnosticsTracker {
    events = [];
    record(event) {
        const normalized = normalizeWebRtcDiagnosticEvent(event);
        if (!normalized)
            return;
        this.events.push(normalized);
        if (this.events.length > MAX_EVENTS)
            this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    snapshot() {
        return {
            events: this.events.map((event) => ({
                ...event,
                ...(event.candidateCounts ? { candidateCounts: { ...event.candidateCounts } } : {})
            }))
        };
    }
}
/** Parse the only diagnostic payload accepted from the browser. Extra fields fail closed. */
export function parseBrowserWebRtcDiagnosticEvent(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const record = value;
    if (Object.keys(record).some((key) => !["stage", "candidateCounts", "state", "durationMs"].includes(key))) {
        return undefined;
    }
    if (typeof record.stage !== "string" || !BROWSER_STAGES.has(record.stage))
        return undefined;
    return normalizeWebRtcDiagnosticEvent(record);
}
export function emptyWebRtcCandidateCounts() {
    return { host: 0, srflx: 0, prflx: 0, relay: 0 };
}
/** Count only candidate *types* from local SDP; candidate/address strings never leave this function. */
export function webRtcCandidateCountsFromSdp(sdp) {
    const counts = emptyWebRtcCandidateCounts();
    for (const line of sdp.split(/\r?\n/)) {
        if (!line.startsWith("a=candidate:"))
            continue;
        const match = /\styp\s+(host|srflx|prflx|relay)(?:\s|$)/i.exec(line);
        if (!match)
            continue;
        const type = match[1].toLowerCase();
        counts[type] = Math.min(MAX_CANDIDATES_PER_TYPE, counts[type] + 1);
    }
    return counts;
}
function normalizeWebRtcDiagnosticEvent(event) {
    if (!ALL_STAGES.has(event.stage))
        return undefined;
    const allowedByStage = {
        "broker.prepare.request": ["stage"],
        "broker.prepare.success": ["stage", "durationMs"],
        "broker.prepare.failure": ["stage", "durationMs"],
        "relay.credential.unavailable": ["stage", "reason"],
        "browser.gather.complete": ["stage", "candidateCounts", "durationMs"],
        "browser.peer.state": ["stage", "state"],
        "broker.connect.request": ["stage"],
        "server.answer.ready": ["stage", "candidateCounts", "durationMs"],
        "broker.connect.success": ["stage", "durationMs"],
        "broker.connect.failure": ["stage", "durationMs"],
        "server.peer.state": ["stage", "state"],
        "host.target.alive": ["stage"],
        "host.target.missing": ["stage"],
        "host.window.ready": ["stage"],
        "host.window.failure.none": ["stage"],
        "host.window.failure.multiple": ["stage"],
        "host.capture.started": ["stage"],
        "host.frame.ready": ["stage"],
        "host.input.focus.ready": ["stage"],
        "host.input.tap.sent": ["stage"],
        "host.input.pointer.helper_ready": ["stage"],
        "host.input.pointer.helper_failure": ["stage"],
        "host.input.pointer.move_ready": ["stage"],
        "host.input.pointer.authority_ready": ["stage"],
        "host.input.pointer.down_sent": ["stage"],
        "host.input.text.native_ax": ["stage"],
        "host.input.text.pid_keyboard": ["stage"],
        "host.input.text.event_creation_failure": ["stage"],
        "host.input.text.activation_rejected": ["stage"],
        "host.input.text.native_boundary_rejected": ["stage"],
        "host.input.failure": ["stage"],
        "host.capture.failure": ["stage"],
        "host.capture.failure.x11": ["stage"],
        "host.capture.failure.encoder": ["stage"],
        "host.capture.failure.option": ["stage"],
        "host.capture.failure.other": ["stage"]
    };
    const eventRecord = event;
    if (Object.keys(eventRecord).some((key) => !allowedByStage[event.stage].includes(key)))
        return undefined;
    const normalized = { stage: event.stage };
    if (event.candidateCounts !== undefined) {
        const counts = normalizeCandidateCounts(event.candidateCounts);
        if (!counts)
            return undefined;
        normalized.candidateCounts = counts;
    }
    if (event.state !== undefined) {
        if (!PEER_STATES.has(event.state))
            return undefined;
        normalized.state = event.state;
    }
    if (event.reason !== undefined) {
        if (!RELAY_FAILURE_REASONS.has(event.reason))
            return undefined;
        normalized.reason = event.reason;
    }
    if (event.durationMs !== undefined) {
        if (typeof event.durationMs !== "number" || !Number.isFinite(event.durationMs) || event.durationMs < 0 || event.durationMs > MAX_DURATION_MS) {
            return undefined;
        }
        normalized.durationMs = Math.round(event.durationMs * 10) / 10;
    }
    return normalized;
}
function normalizeCandidateCounts(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const record = value;
    const keys = ["host", "srflx", "prflx", "relay"];
    if (Object.keys(record).length !== keys.length || Object.keys(record).some((key) => !keys.includes(key))) {
        return undefined;
    }
    const result = emptyWebRtcCandidateCounts();
    for (const key of keys) {
        const count = record[key];
        if (!Number.isSafeInteger(count) || count < 0 || count > MAX_CANDIDATES_PER_TYPE)
            return undefined;
        result[key] = count;
    }
    return result;
}
//# sourceMappingURL=webrtc-diagnostics.js.map