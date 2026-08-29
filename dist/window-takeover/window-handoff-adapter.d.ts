import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { OperatorDiagnosticsSnapshot } from "../core/operator-diagnostics.js";
import { type ManagedOperatorDiagnosticsSnapshot } from "../browser-takeover/managed-operator-diagnostics.js";
import { type WebRtcDiagnosticsSnapshot } from "../browser-takeover/webrtc-diagnostics.js";
import type { WebRtcLatencyComparison } from "../browser-takeover/webrtc-latency.js";
import type { TakeoverCompletionEvent, TakeoverHostTarget, TakeoverInterventionRef } from "../browser-takeover/broker.js";
import type { SpawnedWebRtcRuntimeProviderConfig, WebRtcHumanInputPolicy } from "../browser-takeover/webrtc-runtime-diagnostics.js";
import type { TakeoverBrokerConfig } from "../browser-takeover/broker.js";
import { type BrowserHandoffManagedFallbackConfig } from "../browser-takeover/managed-handoff-runtime.js";
export type { BrowserHandoffManagedFallbackConfig } from "../browser-takeover/managed-handoff-runtime.js";
export interface WindowHandoffSuccessorPolicy {
    /** Admit only one newly observed successor owned by the exact same process. */
    mode: "same_process";
    /** Bounded post-Human-action probe window. Defaults to 800 ms. */
    transitionWindowMs?: number;
}
export interface WindowHandoffInitialSecureWindowPolicy {
    /** Admit only Apple's exact LocalAuthentication user-presence dialog as the initial target. */
    mode: "macos_local_authentication";
}
export interface WindowHandoffAdapterConfig {
    takeover: TakeoverBrokerConfig;
    runtime: SpawnedWebRtcRuntimeProviderConfig;
    /** Optional Handoff-owned managed fallback. Consumers do not select WSS/TURN providers. */
    managedFallback?: BrowserHandoffManagedFallbackConfig;
    /** Optional Human-only successor-window lineage. Exact-one-window behavior remains the default. */
    successorWindowPolicy?: WindowHandoffSuccessorPolicy;
    /** Optional, default-off admission for Apple's exact LocalAuthentication user-presence dialog. */
    initialSecureWindowPolicy?: WindowHandoffInitialSecureWindowPolicy;
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
    readonly code: "WINDOW_HANDOFF_UNAVAILABLE" | "WINDOW_HANDOFF_TARGET_INVALID" | "WINDOW_HANDOFF_INPUT_POLICY_INVALID" | "WINDOW_HANDOFF_SUCCESSOR_POLICY_INVALID" | "WINDOW_HANDOFF_INITIAL_SECURE_WINDOW_POLICY_INVALID";
    constructor(code: "WINDOW_HANDOFF_UNAVAILABLE" | "WINDOW_HANDOFF_TARGET_INVALID" | "WINDOW_HANDOFF_INPUT_POLICY_INVALID" | "WINDOW_HANDOFF_SUCCESSOR_POLICY_INVALID" | "WINDOW_HANDOFF_INITIAL_SECURE_WINDOW_POLICY_INVALID", message: string);
}
/**
 * First-class bounded OS-window Handoff composition for MCP consumers.
 *
 * Direct WebRTC remains the default. When managed fallback is configured, Handoff owns strict
 * direct WebRTC -> WSS -> optional TURN transitions and still never widens to display capture.
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
    /** Fence a session only after the consumer independently verifies the Human action succeeded. */
    completeAfterVerification(intervention: TakeoverInterventionRef): Promise<boolean>;
    /** Synchronously invalidate a locator that was cancelled before any Human generation was claimed. */
    revokeUnclaimed(interventionId: string): void;
    handle(request: Request, boundPrincipal: string | undefined): Promise<Response>;
    /** Route Node HTTP upgrades only when managed WSS is the active Handoff transport. */
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
    diagnosticsSnapshot(): WebRtcDiagnosticsSnapshot;
    operatorDiagnosticsSnapshot(): OperatorDiagnosticsSnapshot;
    /** Stable content-free managed transport diagnostics; empty when managed fallback is disabled. */
    managedOperatorDiagnosticsSnapshot(): ManagedOperatorDiagnosticsSnapshot;
    latencySnapshot(): WebRtcLatencyComparison;
}
//# sourceMappingURL=window-handoff-adapter.d.ts.map