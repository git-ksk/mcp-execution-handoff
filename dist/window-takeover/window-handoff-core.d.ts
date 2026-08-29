import type { WebRtcDiagnosticsSnapshot } from "../browser-takeover/webrtc-diagnostics.js";
import type { WebRtcLatencyComparison } from "../browser-takeover/webrtc-latency.js";
import { type TakeoverAuthorityReleaseEvent, type TakeoverBrokerConfig, type TakeoverCompletionEvent, type TakeoverHostTarget, type TakeoverInterventionRef } from "../browser-takeover/broker.js";
import { type SpawnedWebRtcRuntimeProviderConfig, type WebRtcHumanInputPolicy } from "../browser-takeover/webrtc-runtime-diagnostics.js";
export interface WindowHandoffCoreSuccessorPolicy {
    mode: "same_process";
    transitionWindowMs?: number;
}
export interface WindowHandoffCoreInitialSecureWindowPolicy {
    mode: "macos_local_authentication";
}
export interface WindowHandoffCoreConfig {
    takeover: TakeoverBrokerConfig;
    runtime: SpawnedWebRtcRuntimeProviderConfig;
    /** Internal facade-selected media profile. Browser leaves this unset. */
    mediaProfile?: "window_text";
    successorWindowPolicy?: WindowHandoffCoreSuccessorPolicy;
    initialSecureWindowPolicy?: WindowHandoffCoreInitialSecureWindowPolicy;
    onComplete?: (event: TakeoverCompletionEvent) => void | Promise<void>;
    onAuthorityReleased?: (event: TakeoverAuthorityReleaseEvent) => void | Promise<void>;
}
export interface WindowHandoffCoreStartRequest {
    intervention: TakeoverInterventionRef;
    principalBinding: string;
    target: TakeoverHostTarget;
    inputPolicy: WebRtcHumanInputPolicy;
}
export declare class WindowHandoffCoreError extends Error {
    readonly code: "UNAVAILABLE" | "TARGET_INVALID" | "INPUT_POLICY_INVALID" | "SUCCESSOR_POLICY_INVALID" | "INITIAL_SECURE_WINDOW_POLICY_INVALID";
    constructor(code: "UNAVAILABLE" | "TARGET_INVALID" | "INPUT_POLICY_INVALID" | "SUCCESSOR_POLICY_INVALID" | "INITIAL_SECURE_WINDOW_POLICY_INVALID", message: string);
}
/** Shared bounded-window WebRTC/session composition used by Browser and Window facades. */
export declare class WindowHandoffCore {
    #private;
    constructor(config: WindowHandoffCoreConfig);
    isEnabled(): boolean;
    isPath(pathname: string): boolean;
    ownsPath(pathname: string): boolean;
    start(request: WindowHandoffCoreStartRequest): string;
    revoke(interventionId: string): Promise<void>;
    completeAfterVerification(intervention: TakeoverInterventionRef): Promise<boolean>;
    /**
     * Synchronously revoke an unclaimed locator/control-plane session.
     * Runtime cleanup remains best-effort inside TakeoverBroker; no Human generation has been claimed.
     */
    revokeUnclaimed(interventionId: string): void;
    handle(request: Request, boundPrincipal: string | undefined): Promise<Response>;
    diagnosticsSnapshot(): WebRtcDiagnosticsSnapshot;
    latencySnapshot(): WebRtcLatencyComparison;
}
export declare function validWindowHandoffTarget(target: TakeoverHostTarget): boolean;
export declare function validWindowHandoffInputPolicy(policy: WebRtcHumanInputPolicy): boolean;
//# sourceMappingURL=window-handoff-core.d.ts.map