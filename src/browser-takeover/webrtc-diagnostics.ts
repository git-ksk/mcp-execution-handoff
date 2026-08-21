export type WebRtcDiagnosticCandidateType = "host" | "srflx" | "prflx" | "relay";
export type WebRtcDiagnosticPeerState = "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed";
export type WebRtcDiagnosticStage =
  | "broker.prepare.request"
  | "broker.prepare.success"
  | "broker.prepare.failure"
  | "browser.gather.complete"
  | "browser.peer.state"
  | "broker.connect.request"
  | "server.answer.ready"
  | "broker.connect.success"
  | "broker.connect.failure"
  | "server.peer.state"
  | "host.window.ready"
  | "host.capture.started"
  | "host.frame.ready"
  | "host.input.focus.ready"
  | "host.input.tap.sent"
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
const PEER_STATES = new Set<WebRtcDiagnosticPeerState>([
  "new", "connecting", "connected", "disconnected", "failed", "closed"
]);
const ALL_STAGES = new Set<WebRtcDiagnosticStage>([
  "broker.prepare.request",
  "broker.prepare.success",
  "broker.prepare.failure",
  "browser.gather.complete",
  "browser.peer.state",
  "broker.connect.request",
  "server.answer.ready",
  "broker.connect.success",
  "broker.connect.failure",
  "server.peer.state",
  "host.window.ready",
  "host.capture.started",
  "host.frame.ready",
  "host.input.focus.ready",
  "host.input.tap.sent",
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
    "browser.gather.complete": ["stage", "candidateCounts", "durationMs"],
    "browser.peer.state": ["stage", "state"],
    "broker.connect.request": ["stage"],
    "server.answer.ready": ["stage", "candidateCounts", "durationMs"],
    "broker.connect.success": ["stage", "durationMs"],
    "broker.connect.failure": ["stage", "durationMs"],
    "server.peer.state": ["stage", "state"],
    "host.window.ready": ["stage"],
    "host.capture.started": ["stage"],
    "host.frame.ready": ["stage"],
    "host.input.focus.ready": ["stage"],
    "host.input.tap.sent": ["stage"],
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
