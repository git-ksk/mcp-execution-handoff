import type { WebRtcDiagnosticsSnapshot } from "../browser-takeover/webrtc-diagnostics.js";
import type { WebRtcLatencyComparison } from "../browser-takeover/webrtc-latency.js";
import type { TakeoverCompletionEvent, TakeoverHostTarget, TakeoverInterventionRef } from "../browser-takeover/broker.js";
import type { SpawnedWebRtcRuntimeProviderConfig, WebRtcHumanInputPolicy } from "../browser-takeover/webrtc-runtime-diagnostics.js";
import type { TakeoverBrokerConfig } from "../browser-takeover/broker.js";
export interface WindowHandoffAdapterConfig {
    takeover: TakeoverBrokerConfig;
    runtime: SpawnedWebRtcRuntimeProviderConfig;
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
    readonly code: "WINDOW_HANDOFF_UNAVAILABLE" | "WINDOW_HANDOFF_TARGET_INVALID" | "WINDOW_HANDOFF_INPUT_POLICY_INVALID";
    constructor(code: "WINDOW_HANDOFF_UNAVAILABLE" | "WINDOW_HANDOFF_TARGET_INVALID" | "WINDOW_HANDOFF_INPUT_POLICY_INVALID", message: string);
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
    handle(request: Request, boundPrincipal: string | undefined): Promise<Response>;
    diagnosticsSnapshot(): WebRtcDiagnosticsSnapshot;
    latencySnapshot(): WebRtcLatencyComparison;
}
//# sourceMappingURL=window-handoff-adapter.d.ts.map