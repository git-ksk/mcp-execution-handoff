import type { WebRtcDiagnosticsSnapshot } from "../browser-takeover/webrtc-diagnostics.js";
import type { WebRtcLatencyComparison } from "../browser-takeover/webrtc-latency.js";
import type { TakeoverCompletionEvent, TakeoverHostTarget, TakeoverInterventionRef } from "../browser-takeover/broker.js";
import type { SpawnedWebRtcRuntimeProviderConfig, WebRtcHumanInputPolicy } from "../browser-takeover/webrtc-runtime-diagnostics.js";
import type { TakeoverBrokerConfig } from "../browser-takeover/broker.js";
export interface WindowHandoffSuccessorPolicy {
    /** Admit only one newly observed successor owned by the exact same process. */
    mode: "same_process";
    /** Bounded post-Human-action probe window. Defaults to 800 ms. */
    transitionWindowMs?: number;
}
export interface WindowHandoffAdapterConfig {
    takeover: TakeoverBrokerConfig;
    runtime: SpawnedWebRtcRuntimeProviderConfig;
    /** Optional Human-only successor-window lineage. Exact-one-window behavior remains the default. */
    successorWindowPolicy?: WindowHandoffSuccessorPolicy;
    /** Called only after Human transport authority is fenced. Consumer performs fresh verification. */
    onComplete?: (event: TakeoverCompletionEvent) => void | Promise<void>;
}
export type WindowHandoffInputPolicy = WebRtcHumanInputPolicy;
export interface WindowHandoffStartRequest {
    intervention: TakeoverInterventionRef;
    principalBinding: string;
    target: TakeoverHostTarget;
    inputPolicy: WindowHandoffInputPolicy;
}
export declare class WindowHandoffAdapterError extends Error {
    readonly code: "WINDOW_HANDOFF_UNAVAILABLE" | "WINDOW_HANDOFF_TARGET_INVALID" | "WINDOW_HANDOFF_INPUT_POLICY_INVALID" | "WINDOW_HANDOFF_SUCCESSOR_POLICY_INVALID";
    constructor(code: "WINDOW_HANDOFF_UNAVAILABLE" | "WINDOW_HANDOFF_TARGET_INVALID" | "WINDOW_HANDOFF_INPUT_POLICY_INVALID" | "WINDOW_HANDOFF_SUCCESSOR_POLICY_INVALID", message: string);
}
/**
 * First-class bounded OS-window WebRTC Handoff composition for MCP consumers.
 *
 * Consumers own application/domain semantics, process lifecycle, intervention policy and fresh
 * verification. Handoff owns locator/session lifecycle, exact process/window capture/input,
 * WebRTC/TURN/reconnect behavior, revoke and privacy-bounded transport diagnostics.
 *
 * This adapter always requires an exact process boundary and never exposes display/desktop-wide
 * capture as a fallback.
 */
export declare class WindowHandoffAdapter {
    #private;
    constructor(config: WindowHandoffAdapterConfig);
    isEnabled(): boolean;
    isPath(pathname: string): boolean;
    ownsPath(pathname: string): boolean;
    start(request: WindowHandoffStartRequest): string;
    revoke(interventionId: string): Promise<void>;
    revokeForIntervention(interventionId: string): Promise<void>;
    /** Synchronously invalidate a locator that was cancelled before any Human generation was claimed. */
    revokeUnclaimed(interventionId: string): void;
    handle(request: Request, boundPrincipal: string | undefined): Promise<Response>;
    diagnosticsSnapshot(): WebRtcDiagnosticsSnapshot;
    latencySnapshot(): WebRtcLatencyComparison;
}
//# sourceMappingURL=window-handoff-adapter.d.ts.map