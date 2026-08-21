export type WebRtcDiagnosticCandidateType = "host" | "srflx" | "prflx" | "relay";
export type WebRtcDiagnosticPeerState = "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed";
export type WebRtcDiagnosticStage = "broker.prepare.request" | "broker.prepare.success" | "broker.prepare.failure" | "browser.gather.complete" | "browser.peer.state" | "broker.connect.request" | "server.answer.ready" | "broker.connect.success" | "broker.connect.failure" | "server.peer.state" | "host.window.ready" | "host.capture.started" | "host.frame.ready" | "host.input.focus.ready" | "host.input.tap.sent" | "host.input.failure" | "host.capture.failure" | "host.capture.failure.x11" | "host.capture.failure.encoder" | "host.capture.failure.option" | "host.capture.failure.other";
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
/**
 * Bounded process-memory-only WebRTC setup diagnostics.
 *
 * Events intentionally contain no session/client/principal identifiers, candidate strings, IPs,
 * SDP, SSRCs, credentials, media, or Human input. Callers should take a snapshot around one
 * disposable acceptance run when they need per-run attribution.
 */
export declare class WebRtcDiagnosticsTracker {
    private readonly events;
    record(event: WebRtcDiagnosticEvent): void;
    snapshot(): WebRtcDiagnosticsSnapshot;
}
/** Parse the only diagnostic payload accepted from the browser. Extra fields fail closed. */
export declare function parseBrowserWebRtcDiagnosticEvent(value: unknown): WebRtcDiagnosticEvent | undefined;
export declare function emptyWebRtcCandidateCounts(): WebRtcDiagnosticCandidateCounts;
/** Count only candidate *types* from local SDP; candidate/address strings never leave this function. */
export declare function webRtcCandidateCountsFromSdp(sdp: string): WebRtcDiagnosticCandidateCounts;
//# sourceMappingURL=webrtc-diagnostics.d.ts.map