import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { OperatorDiagnosticsSnapshot, OperatorDiagnosticsSource } from "../core/operator-diagnostics.js";
import { type DesktopSessionSnapshot } from "../desktop-session/desktop-session.js";
import { type WindowHandoffCoreInitialSecureWindowPolicy, type WindowHandoffCoreStartRequest, type WindowHandoffCoreSuccessorPolicy } from "../window-takeover/window-handoff-core.js";
import type { TakeoverAuthorityReleaseEvent, TakeoverBrokerConfig, TakeoverCompletionEvent, TakeoverInterventionRef } from "./broker.js";
import type { WebRtcDiagnosticsSnapshot } from "./webrtc-diagnostics.js";
import { type WebRtcLatencyComparison } from "./webrtc-latency.js";
import { type WebSocketLatencySnapshot } from "./websocket-latency.js";
import type { SpawnedWebRtcRuntimeProviderConfig } from "./webrtc-runtime.js";
import { WebSocketBrowserHandoff } from "./websocket-relay.js";
import { type ManagedWindowWebSocketHostConfig } from "./managed-window-websocket-surface.js";
import type { ManagedWindowWebSocketSurfaceDiagnostics } from "./websocket-window-surface-diagnostics.js";
import { type BrowserHandoffTransportAttempt, type ManagedHandoffTransportPolicy } from "./transport-fallback-policy.js";
import { type ManagedOperatorDiagnosticEventObserver, type ManagedOperatorDiagnosticsSnapshot } from "./managed-operator-diagnostics.js";
/** Deployment-owned exact-window WSS host configuration. */
export type BrowserHandoffManagedFallbackConfig = ManagedWindowWebSocketHostConfig;
export interface ManagedWindowHandoffRuntimeConfig {
    takeover: TakeoverBrokerConfig;
    runtime: SpawnedWebRtcRuntimeProviderConfig;
    managedFallback?: BrowserHandoffManagedFallbackConfig;
    /** Optional exact transport plan. One entry is an explicit transport-only mode. */
    transportPolicy?: ManagedHandoffTransportPolicy;
    mediaProfile?: "window_text";
    successorWindowPolicy?: WindowHandoffCoreSuccessorPolicy;
    initialSecureWindowPolicy?: WindowHandoffCoreInitialSecureWindowPolicy;
    /** @internal Opt in only for the first-class Window facade; Browser remains outside Desktop Session semantics. */
    desktopSessionBoundary?: "physical_window";
    /** Observe-only bounded managed diagnostic events. Callback failures are contained. */
    onManagedOperatorDiagnosticEvent?: ManagedOperatorDiagnosticEventObserver;
    onComplete?: (event: TakeoverCompletionEvent) => void | Promise<void>;
    onAuthorityReleased?: (event: TakeoverAuthorityReleaseEvent) => void | Promise<void>;
}
/**
 * Internal first-class Browser/Window transport composition.
 *
 * Consumers still receive one ordinary Handoff locator. The browser page asks this runtime for the
 * next locator only after a bounded transport failure; Handoff revokes/fences the active attempt,
 * rotates generation/capability state and then redirects the same Human browser. No Human input is
 * replayed across the boundary and transport/provider credentials never cross this class.
 */
export declare class ManagedWindowHandoffRuntime {
    #private;
    constructor(config: ManagedWindowHandoffRuntimeConfig);
    isEnabled(): boolean;
    isPath(pathname: string): boolean;
    ownsPath(pathname: string): boolean;
    start(request: WindowHandoffCoreStartRequest): string;
    /** @internal Content-free managed WSS surface diagnostics for physical acceptance. */
    managedSurfaceDiagnosticsSnapshot(): ManagedWindowWebSocketSurfaceDiagnostics;
    /** @internal Content-free managed WSS ingress diagnostics for physical acceptance. */
    managedWebSocketDiagnosticsSnapshot(): ReturnType<WebSocketBrowserHandoff["diagnosticsSnapshot"]>;
    /** @internal Content-free managed WSS latency evidence for #160. */
    managedWebSocketLatencySnapshot(): WebSocketLatencySnapshot;
    revoke(interventionId: string): Promise<void>;
    revokeUnclaimed(interventionId: string): void;
    completeAfterVerification(intervention: TakeoverInterventionRef): Promise<boolean>;
    handle(request: Request, boundPrincipal: string | undefined): Promise<Response>;
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
    diagnosticsSnapshot(): WebRtcDiagnosticsSnapshot;
    /** Stable, strict, content-free managed takeover diagnostics for production troubleshooting. */
    managedOperatorDiagnosticsSnapshot(source: Extract<OperatorDiagnosticsSource, "browser_handoff" | "window_handoff">): ManagedOperatorDiagnosticsSnapshot;
    /** @internal Content-free Desktop Session / Display Backend lifecycle evidence for #161. */
    desktopSessionSnapshot(): DesktopSessionSnapshot | undefined;
    latencySnapshot(): WebRtcLatencyComparison;
    operatorDiagnosticsSnapshot(source: Extract<OperatorDiagnosticsSource, "browser_handoff" | "window_handoff">): OperatorDiagnosticsSnapshot;
}
export type ManagedTransportKind = BrowserHandoffTransportAttempt;
//# sourceMappingURL=managed-handoff-runtime.d.ts.map