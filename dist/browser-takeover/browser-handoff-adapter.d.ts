import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { OperatorDiagnosticsSnapshot } from "../core/operator-diagnostics.js";
import { type WebRtcDiagnosticsSnapshot } from "./webrtc-diagnostics.js";
import type { WebRtcLatencyComparison } from "./webrtc-latency.js";
import type { TakeoverBrokerConfig, TakeoverCompletionEvent, TakeoverHostTarget, TakeoverInterventionRef } from "./broker.js";
import type { SpawnedWebRtcRuntimeProviderConfig, WebRtcHumanInputPolicy } from "./webrtc-runtime-diagnostics.js";
import { type BrowserHandoffManagedFallbackConfig } from "./managed-handoff-runtime.js";
export type { BrowserHandoffManagedFallbackConfig } from "./managed-handoff-runtime.js";
export interface BrowserHandoffAdapterConfig {
    takeover: TakeoverBrokerConfig;
    runtime: SpawnedWebRtcRuntimeProviderConfig;
    /** Optional Handoff-owned managed fallback. Consumers do not select WSS/TURN providers. */
    managedFallback?: BrowserHandoffManagedFallbackConfig;
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
 * First-class Browser Handoff composition for standalone MCP consumers.
 *
 * Direct WebRTC remains unchanged by default. When managed fallback is configured, Handoff owns
 * the strict direct WebRTC -> WSS -> optional TURN transition while the consumer keeps one locator
 * and the same Browser lifecycle API.
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
    /** Route Node HTTP upgrades only when managed WSS is the active Handoff transport. */
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
    diagnosticsSnapshot(): WebRtcDiagnosticsSnapshot;
    operatorDiagnosticsSnapshot(): OperatorDiagnosticsSnapshot;
    /** @internal Content-free managed WSS surface diagnostics for physical acceptance. */
    managedSurfaceDiagnosticsSnapshot(): {
        lastFailure: string;
        framesObserved: number;
        lastInputStage: string;
        lastInputBoundaryStage: string;
        inputAttempts: number;
        failure: string;
        failureInputStage: string;
        failureInputBoundaryStage: string;
        lastInputFailureDetail: string;
        failureInputFailureDetail: string;
        lastHelperStopReason: string;
        failureHelperStopReason: string;
        lastHelperCrashReason: string;
        failureHelperCrashReason: string;
        lastHelperExitKind: string;
        failureHelperExitKind: string;
        lastHelperCrashClass: string;
        failureHelperCrashClass: string;
        lastHelperCrashOrigin: string;
        failureHelperCrashOrigin: string;
        lastHelperCrashErrorKind: string;
        failureHelperCrashErrorKind: string;
        lastHelperCrashMessageClass: string;
        failureHelperCrashMessageClass: string;
    };
    /** @internal Content-free managed WSS ingress diagnostics for physical acceptance. */
    managedWebSocketDiagnosticsSnapshot(): {
        disconnectKind: string;
        channelState: string;
        sentFrames: number;
        droppedFrames: number;
        lastFailure: string;
        lastInputStage: string;
        failureDisconnectKind: string;
        failureChannelState: string;
        failureCode: string;
        failureInputStage: string;
    };
    latencySnapshot(): WebRtcLatencyComparison;
}
//# sourceMappingURL=browser-handoff-adapter.d.ts.map