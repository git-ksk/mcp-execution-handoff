export type WebRtcDiagnosticCandidateType = "host" | "srflx" | "prflx" | "relay";
export type WebRtcDiagnosticPeerState = "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed";
export type WebRtcRelayDiagnosticFailureReason = "generation_expired" | "provider_auth" | "provider_rate_limited" | "provider_rejected" | "provider_unavailable" | "response_invalid" | "unknown";
export type WebRtcDiagnosticStage = "broker.prepare.request" | "broker.prepare.success" | "broker.prepare.failure" | "relay.credential.unavailable" | "browser.gather.complete" | "browser.peer.state" | "broker.connect.request" | "server.answer.ready" | "broker.connect.success" | "broker.connect.failure" | "server.peer.state" | "host.target.alive" | "host.target.missing" | "host.window.ready" | "host.window.failure.none" | "host.window.failure.multiple" | "host.capture.started" | "host.frame.ready" | "host.input.focus.ready" | "host.input.tap.sent" | "host.input.pointer.helper_ready" | "host.input.pointer.helper_failure" | "host.input.pointer.move_ready" | "host.input.pointer.authority_ready" | "host.input.pointer.down_sent" | "host.input.pointer.delivery_helper_ready" | "host.input.pointer.delivery_helper_failure" | "host.input.pointer.delivery_arm_failure" | "host.input.pointer.delivery_wait_no_from_server" | "host.input.pointer.delivery_wait_swapped" | "host.input.pointer.delivery_wait_short_data" | "host.input.pointer.delivery_wait_no_event" | "host.input.pointer.delivery_wait_event_mismatch" | "host.input.pointer.delivery_wait_xi2_mismatch" | "host.input.pointer.delivery_wait_window_mismatch" | "host.input.pointer.delivery_wait_coord_mismatch" | "host.input.pointer.delivery_wait_io_failure" | "host.input.pointer.delivery_wait_failure" | "host.input.pointer.delivery_ready" | "host.input.text.native_ax" | "host.input.text.pid_keyboard" | "host.input.text.event_creation_failure" | "host.input.text.activation_rejected" | "host.input.text.native_boundary_rejected" | "host.input.failure" | "host.capture.failure" | "host.capture.failure.x11" | "host.capture.failure.encoder" | "host.capture.failure.option" | "host.capture.failure.other";
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