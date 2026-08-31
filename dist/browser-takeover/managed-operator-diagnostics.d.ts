import type { OperatorDiagnosticsHealth, OperatorDiagnosticsSource } from "../core/operator-diagnostics.js";
import type { ManagedBrowserHandoffFallbackReason } from "./managed-transport-coordinator.js";
import type { BrowserHandoffTransportAttempt } from "./transport-fallback-policy.js";
import type { ExperimentalWebSocketIngressDisconnectKind } from "./websocket-ingress.js";
import type { WebSocketTakeoverFailureCode, WebSocketTakeoverState } from "./websocket-takeover.js";
import type { ManagedWindowWebSocketHelperCrashClass, ManagedWindowWebSocketHelperCrashErrorKind, ManagedWindowWebSocketHelperCrashMessageClass, ManagedWindowWebSocketHelperCrashOrigin, ManagedWindowWebSocketHelperCrashReason, ManagedWindowWebSocketHelperExitKind, ManagedWindowWebSocketHelperStopReason, ManagedWindowWebSocketInputBoundaryStage, ManagedWindowWebSocketInputStage, ManagedWindowWebSocketSurfaceFailure } from "./websocket-window-surface-diagnostics.js";
export declare const MANAGED_OPERATOR_DIAGNOSTICS_SCHEMA_VERSION: 1;
export declare const MANAGED_OPERATOR_DIAGNOSTIC_EVENT_LIMIT: 64;
export type ManagedOperatorDiagnosticEventKind = "transport_transition" | "wss_open" | "wss_degraded" | "wss_failed" | "capture_recovery_attempt" | "input_dispatch_failure" | "helper_restart" | "authority_boundary_lost" | "session_retained" | "session_revoked" | "host_editable_regions_available" | "host_editable_regions_empty" | "host_focus_editable" | "host_focus_not_editable" | "host_successor_probe_started" | "host_successor_admitted" | "host_successor_returned" | "host_successor_none" | "host_successor_ambiguous" | "host_successor_unsupported" | "host_successor_failure" | "client_editable_regions_available" | "client_editable_regions_empty" | "client_tap_editable_predicted" | "client_tap_editable_not_predicted" | "client_keyboard_focus_requested" | "client_keyboard_focus_active" | "client_keyboard_focus_inactive";
export interface ManagedOperatorDiagnosticEvent {
    kind: ManagedOperatorDiagnosticEventKind;
}
/** Observe-only callback. Exceptions are contained and never affect Human/Agent authority. */
export type ManagedOperatorDiagnosticEventObserver = (event: ManagedOperatorDiagnosticEvent) => void;
export type ManagedOperatorAuthorityBoundary = "valid" | "lost";
export type ManagedOperatorSessionDisposition = "none" | "retained" | "revoked";
export type ManagedOperatorTransport = BrowserHandoffTransportAttempt | "none";
export type ManagedOperatorWssChannelState = WebSocketTakeoverState | "none";
export type ManagedOperatorWssFailureCode = WebSocketTakeoverFailureCode | "none";
export type ManagedOperatorWssDisconnectKind = ExperimentalWebSocketIngressDisconnectKind;
export type ManagedOperatorFallbackReason = ManagedBrowserHandoffFallbackReason | "none";
export interface ManagedOperatorWssDiagnostics {
    namespace: "managed_wss";
    channelState: ManagedOperatorWssChannelState;
    channelFailure: ManagedOperatorWssFailureCode;
    disconnectKind: ManagedOperatorWssDisconnectKind;
    framesObserved: number;
    framesSent: number;
    framesDropped: number;
    surfaceFailure: ManagedWindowWebSocketSurfaceFailure;
    inputAttempts: number;
    lastInputStage: ManagedWindowWebSocketInputStage;
    lastInputBoundaryStage: ManagedWindowWebSocketInputBoundaryStage;
    helperStopReason: ManagedWindowWebSocketHelperStopReason;
    helperCrashReason: ManagedWindowWebSocketHelperCrashReason;
    helperExitKind: ManagedWindowWebSocketHelperExitKind;
    helperCrashClass: ManagedWindowWebSocketHelperCrashClass;
    helperCrashOrigin: ManagedWindowWebSocketHelperCrashOrigin;
    helperCrashErrorKind: ManagedWindowWebSocketHelperCrashErrorKind;
    helperCrashMessageClass: ManagedWindowWebSocketHelperCrashMessageClass;
    authorityBoundary: ManagedOperatorAuthorityBoundary;
    sessionDisposition: ManagedOperatorSessionDisposition;
}
export interface ManagedOperatorDiagnosticsSnapshot {
    version: typeof MANAGED_OPERATOR_DIAGNOSTICS_SCHEMA_VERSION;
    source: Extract<OperatorDiagnosticsSource, "browser_handoff" | "window_handoff">;
    namespace: "managed_handoff";
    health: OperatorDiagnosticsHealth;
    currentTransport: ManagedOperatorTransport;
    previousTransport: ManagedOperatorTransport;
    generation: number;
    transitionCount: number;
    fallbackReason: ManagedOperatorFallbackReason;
    wss: ManagedOperatorWssDiagnostics;
    events: ManagedOperatorDiagnosticEvent[];
}
/** Strict closed-world parser for the content-free managed takeover operator contract. */
export declare function parseManagedOperatorDiagnosticsSnapshot(value: unknown): ManagedOperatorDiagnosticsSnapshot;
export declare class ManagedOperatorDiagnosticEvents {
    #private;
    constructor(observer?: ManagedOperatorDiagnosticEventObserver);
    record(kind: ManagedOperatorDiagnosticEventKind): void;
    snapshot(): ManagedOperatorDiagnosticEvent[];
}
/** Empty content-free managed snapshot for adapters running without managed fallback. */
export declare function emptyManagedOperatorDiagnosticsSnapshot(source: ManagedOperatorDiagnosticsSnapshot["source"]): ManagedOperatorDiagnosticsSnapshot;
//# sourceMappingURL=managed-operator-diagnostics.d.ts.map