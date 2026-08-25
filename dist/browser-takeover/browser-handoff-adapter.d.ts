import type { WebRtcDiagnosticsSnapshot } from "./webrtc-diagnostics.js";
import type { WebRtcLatencyComparison } from "./webrtc-latency.js";
import type { TakeoverBrokerConfig, TakeoverCompletionEvent, TakeoverHostTarget, TakeoverInterventionRef } from "./broker.js";
import type { SpawnedWebRtcRuntimeProviderConfig, WebRtcHumanInputPolicy } from "./webrtc-runtime-diagnostics.js";
export interface BrowserHandoffAdapterConfig {
    takeover: TakeoverBrokerConfig;
    runtime: SpawnedWebRtcRuntimeProviderConfig;
    /** Called only after Human transport authority is fenced. Consumer performs fresh verification. */
    onComplete?: (event: TakeoverCompletionEvent) => void | Promise<void>;
}
export type BrowserHandoffInputPolicy = WebRtcHumanInputPolicy;
export interface BrowserHandoffStartRequest {
    intervention: TakeoverInterventionRef;
    principalBinding: string;
    target: TakeoverHostTarget;
    inputPolicy: BrowserHandoffInputPolicy;
}
export declare class BrowserHandoffAdapterError extends Error {
    readonly code: "BROWSER_HANDOFF_UNAVAILABLE" | "BROWSER_HANDOFF_TARGET_INVALID" | "BROWSER_HANDOFF_INPUT_POLICY_INVALID";
    constructor(code: "BROWSER_HANDOFF_UNAVAILABLE" | "BROWSER_HANDOFF_TARGET_INVALID" | "BROWSER_HANDOFF_INPUT_POLICY_INVALID", message: string);
}
/**
 * First-class Browser WebRTC Handoff composition for standalone MCP consumers.
 *
 * Browser/profile/authentication semantics remain consumer-owned. This facade reuses the same
 * bounded exact-window WebRTC/session core as `WindowHandoffAdapter`, while preserving the existing
 * Browser public API and its explicit no-HTTP-frame-downgrade contract.
 */
export declare class BrowserHandoffAdapter {
    #private;
    constructor(config: BrowserHandoffAdapterConfig);
    isEnabled(): boolean;
    isPath(pathname: string): boolean;
    ownsPath(pathname: string): boolean;
    start(request: BrowserHandoffStartRequest): string;
    revoke(interventionId: string): Promise<void>;
    revokeForIntervention(interventionId: string): Promise<void>;
    handle(request: Request, boundPrincipal: string | undefined): Promise<Response>;
    diagnosticsSnapshot(): WebRtcDiagnosticsSnapshot;
    latencySnapshot(): WebRtcLatencyComparison;
}
//# sourceMappingURL=browser-handoff-adapter.d.ts.map