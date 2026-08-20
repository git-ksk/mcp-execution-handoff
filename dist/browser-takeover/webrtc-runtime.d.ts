import { spawn } from "node:child_process";
import type { TakeoverGrant } from "./session.js";
export interface WebRtcTakeoverRuntimeBinding {
    takeoverSessionId: string;
    interventionId: string;
    epoch: number;
    principalBinding: string;
    clientBinding: string;
    clientGeneration: number;
    expiresAt: number;
}
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
    start(binding: WebRtcTakeoverRuntimeBinding, offer: WebRtcSessionDescription, hooks: WebRtcRuntimeHooks): Promise<WebRtcSessionDescription>;
    reconnect(binding: WebRtcTakeoverRuntimeBinding, offer: WebRtcSessionDescription, hooks: WebRtcRuntimeHooks): Promise<WebRtcSessionDescription>;
    revoke(takeoverSessionId: string): Promise<void>;
    revokeForIntervention(interventionId: string): Promise<void>;
}
export declare class WebRtcTakeoverRuntimeError extends Error {
    readonly code: "WEBRTC_OFFER_INVALID" | "WEBRTC_RUNTIME_ALREADY_ACTIVE" | "WEBRTC_RUNTIME_START_FAILED" | "WEBRTC_RUNTIME_REVOKE_FAILED";
    constructor(code: "WEBRTC_OFFER_INVALID" | "WEBRTC_RUNTIME_ALREADY_ACTIVE" | "WEBRTC_RUNTIME_START_FAILED" | "WEBRTC_RUNTIME_REVOKE_FAILED", message: string);
}
export declare function webRtcBindingFromGrant(grant: TakeoverGrant): WebRtcTakeoverRuntimeBinding;
export declare function parseWebRtcOffer(value: unknown): WebRtcSessionDescription;
export interface SpawnedWebRtcRuntimeProviderConfig {
    hostExecutable: string;
    hostArgs?: string[];
    displayId?: number;
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
    private readonly config;
    private readonly active;
    private readonly spawnProcess;
    constructor(config: SpawnedWebRtcRuntimeProviderConfig);
    start(binding: WebRtcTakeoverRuntimeBinding, offer: WebRtcSessionDescription, hooks: WebRtcRuntimeHooks): Promise<WebRtcSessionDescription>;
    reconnect(binding: WebRtcTakeoverRuntimeBinding, offer: WebRtcSessionDescription, hooks: WebRtcRuntimeHooks): Promise<WebRtcSessionDescription>;
    revoke(takeoverSessionId: string): Promise<void>;
    revokeForIntervention(interventionId: string): Promise<void>;
    private spawnHost;
    private attachPeer;
    private attachHost;
    private writeFrame;
    private handleChannelMessage;
    private canWriteHostInput;
    private writeHostInput;
    private writeHostCommand;
    private sendEditableFeedback;
    private end;
    private waitForSpawn;
    private waitForExitOrTerminate;
}
//# sourceMappingURL=webrtc-runtime.d.ts.map