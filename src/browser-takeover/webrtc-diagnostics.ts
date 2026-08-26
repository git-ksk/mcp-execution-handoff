export type WebRtcDiagnosticCandidateType = "host" | "srflx" | "prflx" | "relay";
export type WebRtcDiagnosticPeerState = "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed";
export type WebRtcRelayDiagnosticFailureReason =
  | "generation_expired"
  | "provider_auth"
  | "provider_rate_limited"
  | "provider_rejected"
  | "provider_unavailable"
  | "response_invalid"
  | "unknown";
export type WebRtcDiagnosticStage =
  | "broker.prepare.request"
  | "broker.prepare.success"
  | "broker.prepare.failure"
  | "relay.credential.unavailable"
  | "browser.gather.complete"
  | "browser.peer.state"
  | "broker.connect.request"
  | "server.answer.ready"
  | "broker.connect.success"
  | "broker.connect.failure"
  | "server.peer.state"
  | "host.target.alive"
  | "host.target.missing"
  | "host.window.ready"
  | "host.window.failure.none"
  | "host.window.failure.multiple"
  | "host.capture.started"
  | "host.frame.ready"
  | "host.input.focus.ready"
  | "host.input.tap.sent"
  | "host.input.pointer.helper_ready"
  | "host.input.pointer.helper_failure"
  | "host.input.pointer.move_ready"
  | "host.input.pointer.authority_ready"
  | "host.input.pointer.down_sent"
  | "host.input.pointer.delivery_helper_ready"
  | "host.input.pointer.delivery_helper_failure"
  | "host.input.pointer.delivery_arm_failure"
  | "host.input.pointer.delivery_wait_no_from_server_creator_match"
  | "host.input.pointer.delivery_wait_no_from_server_creator_mismatch"
  | "host.input.pointer.delivery_wait_no_from_server_creator_unknown"
  | "host.input.pointer.delivery_wait_swapped"
  | "host.input.pointer.delivery_wait_short_data"
  | "host.input.pointer.delivery_wait_no_event"
  | "host.input.pointer.delivery_wait_event_mismatch"
  | "host.input.pointer.delivery_wait_xi2_mismatch"
  | "host.input.pointer.delivery_wait_window_mismatch"
  | "host.input.pointer.delivery_wait_coord_mismatch"
  | "host.input.pointer.delivery_wait_io_failure"
  | "host.input.pointer.delivery_wait_failure"
  | "host.input.pointer.delivery_ready"
  | "host.input.text.native_ax"
  | "host.input.text.pid_keyboard"
  | "host.input.text.event_creation_failure"
  | "host.input.text.activation_rejected"
  | "host.input.text.native_boundary_rejected"
  | "host.input.failure"
  | "host.capture.failure"
  | "host.capture.failure.x11"
  | "host.capture.failure.encoder"
  | "host.capture.failure.option"
  | "host.capture.failure.other";

export interface WebRtcDiagnosticCandidateCounts {
  host: number;
  srflx: number;
  prflx: number;
  relay: number;
}

export interface WebRtcDiagnosticEvent {
  stage: WebRtcDiagnosticStage;
  candidateCounts?: WebRtcDiagnosticCandidateCounts;
  state?: WebRtcDiagnosticPeerState;
  durationMs?: number;
  reason?: WebRtcRelayDiagnosticFailureReason;
}

export interface WebRtcDiagnosticsSnapshot {
  events: WebRtcDiagnosticEvent[];
}

const MAX_EVENTS = 128;
const MAX_CANDIDATES_PER_TYPE = 64;
const MAX_DURATION_MS = 120_000;
const BROWSER_STAGES = new Set<WebRtcDiagnosticStage>([
  "browser.gather.complete",
  "browser.peer.state"
]);
const RELAY_FAILURE_REASONS = new Set<WebRtcRelayDiagnosticFailureReason>([
  "generation_expired", "provider_auth", "provider_rate_limited", "provider_rejected",
  "provider_unavailable", "response_invalid", "unknown"
]);
const PEER_STATES = new Set<WebRtcDiagnosticPeerState>([
  "new", "connecting", "connected", "disconnected", "failed", "closed"
]);
const ALL_STAGES = new Set<WebRtcDiagnosticStage>([
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
  "host.input.pointer.delivery_ready",
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
  private readonly events: WebRtcDiagnosticEvent[] = [];

  record(event: WebRtcDiagnosticEvent): void {
    const normalized = normalizeWebRtcDiagnosticEvent(event);
    if (!normalized) return;
    this.events.push(normalized);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  snapshot(): WebRtcDiagnosticsSnapshot {
    return {
      events: this.events.map((event) => ({
        ...event,
        ...(event.candidateCounts ? { candidateCounts: { ...event.candidateCounts } } : {})
      }))
    };
  }
}

/** Parse the only diagnostic payload accepted from the browser. Extra fields fail closed. */
export function parseBrowserWebRtcDiagnosticEvent(value: unknown): WebRtcDiagnosticEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["stage", "candidateCounts", "state", "durationMs"].includes(key))) {
    return undefined;
  }
  if (typeof record.stage !== "string" || !BROWSER_STAGES.has(record.stage as WebRtcDiagnosticStage)) return undefined;
  return normalizeWebRtcDiagnosticEvent(record as unknown as WebRtcDiagnosticEvent);
}

export function emptyWebRtcCandidateCounts(): WebRtcDiagnosticCandidateCounts {
  return { host: 0, srflx: 0, prflx: 0, relay: 0 };
}

/** Count only candidate *types* from local SDP; candidate/address strings never leave this function. */
export function webRtcCandidateCountsFromSdp(sdp: string): WebRtcDiagnosticCandidateCounts {
  const counts = emptyWebRtcCandidateCounts();
  for (const line of sdp.split(/\r?\n/)) {
    if (!line.startsWith("a=candidate:")) continue;
    const match = /\styp\s+(host|srflx|prflx|relay)(?:\s|$)/i.exec(line);
    if (!match) continue;
    const type = match[1]!.toLowerCase() as WebRtcDiagnosticCandidateType;
    counts[type] = Math.min(MAX_CANDIDATES_PER_TYPE, counts[type] + 1);
  }
  return counts;
}

function normalizeWebRtcDiagnosticEvent(event: WebRtcDiagnosticEvent): WebRtcDiagnosticEvent | undefined {
  if (!ALL_STAGES.has(event.stage)) return undefined;
  const allowedByStage: Record<WebRtcDiagnosticStage, readonly string[]> = {
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
    "host.input.pointer.delivery_helper_ready": ["stage"],
    "host.input.pointer.delivery_helper_failure": ["stage"],
    "host.input.pointer.delivery_arm_failure": ["stage"],
    "host.input.pointer.delivery_wait_no_from_server_creator_match": ["stage"],
    "host.input.pointer.delivery_wait_no_from_server_creator_mismatch": ["stage"],
    "host.input.pointer.delivery_wait_no_from_server_creator_unknown": ["stage"],
    "host.input.pointer.delivery_wait_swapped": ["stage"],
    "host.input.pointer.delivery_wait_short_data": ["stage"],
    "host.input.pointer.delivery_wait_no_event": ["stage"],
    "host.input.pointer.delivery_wait_event_mismatch": ["stage"],
    "host.input.pointer.delivery_wait_xi2_mismatch": ["stage"],
    "host.input.pointer.delivery_wait_window_mismatch": ["stage"],
    "host.input.pointer.delivery_wait_coord_mismatch": ["stage"],
    "host.input.pointer.delivery_wait_io_failure": ["stage"],
    "host.input.pointer.delivery_wait_failure": ["stage"],
    "host.input.pointer.delivery_ready": ["stage"],
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
  const eventRecord = event as unknown as Record<string, unknown>;
  if (Object.keys(eventRecord).some((key) => !allowedByStage[event.stage].includes(key))) return undefined;

  const normalized: WebRtcDiagnosticEvent = { stage: event.stage };
  if (event.candidateCounts !== undefined) {
    const counts = normalizeCandidateCounts(event.candidateCounts);
    if (!counts) return undefined;
    normalized.candidateCounts = counts;
  }
  if (event.state !== undefined) {
    if (!PEER_STATES.has(event.state)) return undefined;
    normalized.state = event.state;
  }
  if (event.reason !== undefined) {
    if (!RELAY_FAILURE_REASONS.has(event.reason)) return undefined;
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

function normalizeCandidateCounts(value: WebRtcDiagnosticCandidateCounts): WebRtcDiagnosticCandidateCounts | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as unknown as Record<string, unknown>;
  const keys = ["host", "srflx", "prflx", "relay"] as const;
  if (Object.keys(record).length !== keys.length || Object.keys(record).some((key) => !keys.includes(key as typeof keys[number]))) {
    return undefined;
  }
  const result = emptyWebRtcCandidateCounts();
  for (const key of keys) {
    const count = record[key];
    if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > MAX_CANDIDATES_PER_TYPE) return undefined;
    result[key] = count as number;
  }
  return result;
}
