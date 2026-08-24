import type { WebRtcDiagnosticsSnapshot } from "./webrtc-diagnostics.js";
import type { WebRtcLatencyComparison } from "./webrtc-latency.js";
import { type TakeoverBrokerConfig, type TakeoverCompletionEvent, type TakeoverHostTarget, type TakeoverInterventionRef } from "./broker.js";
import { type SpawnedWebRtcRuntimeProviderConfig, type WebRtcHumanInputPolicy } from "./webrtc-runtime-diagnostics.js";
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
 * Consumers own why Human intervention is required, browser/profile lifecycle, semantic/input
 * policy, and fresh post-Human verification. Handoff owns the short-lived Browser Handoff
 * locator, WebRTC runtime, direct/relay transport behavior, exact target binding, reconnect
 * generation fencing, revoke, and bounded transport diagnostics.
 *
 * This adapter deliberately has no generic HTTP-frame start method. A missing/unavailable WebRTC
 * runtime therefore cannot silently downgrade a canonical Browser Handoff into screenshot polling.
 */
export declare class BrowserHandoffAdapter {
    #private;
    constructor(config: BrowserHandoffAdapterConfig);
    isEnabled(): boolean;
    isPath(pathname: string): boolean;
    /**
     * Return whether this high-level adapter owns the concrete Browser Handoff route.
     *
     * Consumers that also host a low-level `TakeoverBroker` can use this to route only WebRTC
     * sessions created by this adapter here, while leaving legacy HTTP/native sessions on the other
     * broker. The shared WebRTC client script is adapter-owned; the legacy client script is not.
     */
    ownsPath(pathname: string): boolean;
    /**
     * Issue one short-lived locator for an exact browser target.
     *
     * Locator issuance only means the control-plane session exists. Runtime/media readiness is
     * established later by the existing WebRTC prepare/connect path, which preserves the host-window
     * and first-media-frame readiness gates before an answer is returned.
     */
    start(request: BrowserHandoffStartRequest): string;
    revoke(interventionId: string): Promise<void>;
    /** Alias for consumers that already use broker-style lifecycle naming. */
    revokeForIntervention(interventionId: string): Promise<void>;
    handle(request: Request, boundPrincipal: string | undefined): Promise<Response>;
    diagnosticsSnapshot(): WebRtcDiagnosticsSnapshot;
    latencySnapshot(): WebRtcLatencyComparison;
}
//# sourceMappingURL=browser-handoff-adapter.d.ts.map