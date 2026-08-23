import { spawn } from "node:child_process";
import type { TakeoverGrant } from "./session.js";
import { type WebRtcBrowserIceConfiguration, type WebRtcTakeoverRuntimeBinding } from "./webrtc-ice.js";
import { type WebRtcLatencyComparison, type WebRtcLatencySample } from "./webrtc-latency.js";
import { type WebRtcDiagnosticEvent, type WebRtcDiagnosticsSnapshot } from "./webrtc-diagnostics.js";
export type { WebRtcTakeoverRuntimeBinding } from "./webrtc-ice.js";
export interface WebRtcSessionDescription {
    type: "offer" | "answer";
    sdp: string;
}
export type WebRtcHumanInput = {
    kind: "tap";
    x: number;
    y: number;
} | {
    kind: "scroll";
    deltaX: number;
    deltaY: number;
} | {
    kind: "text";
    text: string;
} | {
    kind: "key";
    key: "Backspace" | "Enter";
};
export interface WebRtcRuntimeHooks {
    beginInput(): () => void;
    disconnected(): void;
}
export interface WebRtcTakeoverRuntimeProvider {
    prepare(binding: WebRtcTakeoverRuntimeBinding): Promise<WebRtcBrowserIceConfiguration>;
    start(binding: WebRtcTakeoverRuntimeBinding, offer: WebRtcSessionDescription, hooks: WebRtcRuntimeHooks): Promise<WebRtcSessionDescription>;
    reconnect(binding: WebRtcTakeoverRuntimeBinding, offer: WebRtcSessionDescription, hooks: WebRtcRuntimeHooks): Promise<WebRtcSessionDescription>;
    recordLatency(takeoverSessionId: string, sample: WebRtcLatencySample): void;
    latencySnapshot(): WebRtcLatencyComparison;
    recordDiagnostic(event: WebRtcDiagnosticEvent): void;
    diagnosticsSnapshot(): WebRtcDiagnosticsSnapshot;
    revoke(takeoverSessionId: string): Promise<void>;
    revokeForIntervention(interventionId: string): Promise<void>;
}
export type WebRtcRuntimeStartStage = "host_spawn" | "host_ready" | "remote_description" | "track_setup" | "answer_create" | "local_description" | "answer_finalize";
export type WebRtcRuntimeStartReason = "peer_closed" | "host_not_ready" | "answer_signaling_state" | "answer_remote_description_missing" | "transceiver_missing" | "sctp_missing" | "invalid_media_kind" | "other";
export type WebRtcRuntimeSignalingState = "stable" | "have-local-offer" | "have-remote-offer" | "have-local-pranswer" | "have-remote-pranswer" | "closed";
export declare class WebRtcTakeoverRuntimeError extends Error {
    readonly code: "WEBRTC_OFFER_INVALID" | "WEBRTC_RUNTIME_ALREADY_ACTIVE" | "WEBRTC_ICE_NOT_PREPARED" | "WEBRTC_RUNTIME_START_FAILED" | "WEBRTC_RUNTIME_REVOKE_FAILED";
    readonly startStage?: WebRtcRuntimeStartStage | undefined;
    readonly startReason?: WebRtcRuntimeStartReason | undefined;
    readonly startSignalingState?: WebRtcRuntimeSignalingState | undefined;
    constructor(code: "WEBRTC_OFFER_INVALID" | "WEBRTC_RUNTIME_ALREADY_ACTIVE" | "WEBRTC_ICE_NOT_PREPARED" | "WEBRTC_RUNTIME_START_FAILED" | "WEBRTC_RUNTIME_REVOKE_FAILED", message: string, startStage?: WebRtcRuntimeStartStage | undefined, startReason?: WebRtcRuntimeStartReason | undefined, startSignalingState?: WebRtcRuntimeSignalingState | undefined);
}
export declare function webRtcBindingFromGrant(grant: TakeoverGrant, targetProcessId?: number, targetWindowId?: number): WebRtcTakeoverRuntimeBinding;
export declare function parseWebRtcOffer(value: unknown): WebRtcSessionDescription;
export interface SpawnedWebRtcRuntimeProviderConfig {
    hostExecutable: string;
    hostArgs?: string[];
    displayId?: number;
    displayName?: string;
    spawnProcess?: typeof spawn;
}
/**
 * Browser WebRTC Human data plane.
 *
 * SDP/ICE/DTLS state, encoded frames and Human input exist only in process memory. The provider
 * deliberately has no persistence/logging hooks and never returns frame/input data to the broker.
 * ScreenCaptureKit H.264 arrives from a short-lived macOS helper over stdout; bounded Human input
 * is written to that helper over stdin. The only broker-visible state is the generation binding.
 */
export declare class SpawnedWebRtcRuntimeProvider implements WebRtcTakeoverRuntimeProvider {
    #private;
    private readonly config;
    private readonly active;
    private readonly prepared;
    private readonly latency;
    private readonly diagnostics;
    private readonly spawnProcess;
    constructor(config: SpawnedWebRtcRuntimeProviderConfig);
    prepare(binding: WebRtcTakeoverRuntimeBinding): Promise<WebRtcBrowserIceConfiguration>;
    recordLatency(takeoverSessionId: string, sample: WebRtcLatencySample): void;
    latencySnapshot(): WebRtcLatencyComparison;
    recordDiagnostic(event: WebRtcDiagnosticEvent): void;
    diagnosticsSnapshot(): WebRtcDiagnosticsSnapshot;
    start(binding: WebRtcTakeoverRuntimeBinding, offer: WebRtcSessionDescription, hooks: WebRtcRuntimeHooks): Promise<WebRtcSessionDescription>;
    reconnect(binding: WebRtcTakeoverRuntimeBinding, offer: WebRtcSessionDescription, hooks: WebRtcRuntimeHooks): Promise<WebRtcSessionDescription>;
    revoke(takeoverSessionId: string): Promise<void>;
    revokeForIntervention(interventionId: string): Promise<void>;
    private revokePrepared;
    private spawnHost;
    private attachPeer;
    private attachHost;
    private writeFrame;
    private enqueueConnectedFrame;
    private drainLatestFrames;
    private sendFrame;
    private requestIdr;
    private handleChannelMessage;
    private canWriteHostInput;
    private writeHostInput;
    private writeHostCommand;
    private sendEditableFeedback;
    private sendEditableRegions;
    private end;
    private waitForSpawn;
    private waitForExitOrTerminate;
}
//# sourceMappingURL=webrtc-runtime.d.ts.map