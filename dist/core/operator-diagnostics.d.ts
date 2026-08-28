import type { ExecutionAuthority, InterventionStatus } from "./lifecycle.js";
export declare const OPERATOR_DIAGNOSTICS_SCHEMA_VERSION: 1;
export declare const OPERATOR_DIAGNOSTICS_SOURCES: readonly ["browser_handoff", "window_handoff", "terminal_handoff"];
export type OperatorDiagnosticsSource = (typeof OPERATOR_DIAGNOSTICS_SOURCES)[number];
export type OperatorDiagnosticsHealth = "idle" | "starting" | "available" | "degraded" | "failed";
export type OperatorDiagnosticsFailureCategory = "target" | "transport" | "input" | "recovery";
export type OperatorDiagnosticsPeerState = "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed";
export type OperatorManagedTransportClass = "webrtc_direct" | "websocket_relay" | "webrtc_relay" | "none";
export type OperatorManagedFallbackReason = "transport_unavailable";
export interface OperatorDiagnosticsCandidateCounts {
    host: number;
    srflx: number;
    prflx: number;
    relay: number;
}
export interface OperatorWebRtcTransportDiagnostics {
    namespace: "webrtc";
    eventCount: number;
    peerState?: OperatorDiagnosticsPeerState;
    candidateCounts?: OperatorDiagnosticsCandidateCounts;
}
export interface OperatorManagedHandoffTransportDiagnostics {
    namespace: "managed_handoff";
    currentTransport: OperatorManagedTransportClass;
    lastTransport: OperatorManagedTransportClass;
    generation: number;
    transitionCount: number;
    lastFallbackReason?: OperatorManagedFallbackReason;
}
export interface OperatorTerminalSessionDiagnostics {
    namespace: "terminal_session";
    alive: boolean;
    humanDisconnected: boolean;
    synchronizationRequired: boolean;
}
export interface OperatorTerminalTransportDiagnostics {
    namespace: "terminal_webrtc";
    ready: boolean;
    disconnected: boolean;
    completed: boolean;
    faulted: boolean;
    queuedEvents: number;
}
export type OperatorDiagnosticsSnapshot = {
    version: typeof OPERATOR_DIAGNOSTICS_SCHEMA_VERSION;
    source: "browser_handoff" | "window_handoff";
    health: OperatorDiagnosticsHealth;
    failureCategory?: OperatorDiagnosticsFailureCategory;
    transport: OperatorWebRtcTransportDiagnostics | OperatorManagedHandoffTransportDiagnostics;
} | {
    version: typeof OPERATOR_DIAGNOSTICS_SCHEMA_VERSION;
    source: "terminal_handoff";
    health: OperatorDiagnosticsHealth;
    authority: ExecutionAuthority;
    phase?: InterventionStatus;
    failureCategory?: OperatorDiagnosticsFailureCategory;
    terminal: OperatorTerminalSessionDiagnostics;
    transport: OperatorTerminalTransportDiagnostics | null;
};
/**
 * Strict parser for the stable process-memory operator summary. It intentionally has no generic
 * identifier, payload, timestamp, message, target identity, or recovery-authority field.
 */
export declare function parseOperatorDiagnosticsSnapshot(value: unknown): OperatorDiagnosticsSnapshot;
//# sourceMappingURL=operator-diagnostics.d.ts.map