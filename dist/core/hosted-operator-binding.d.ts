import { HostedWorkerRegistry, type HostedWorkerRouteLease } from "./hosted-worker.js";
export type HostedOperatorBindingErrorCode = "HOSTED_OPERATOR_SESSION_INVALID" | "HOSTED_OPERATOR_SESSION_EXPIRED" | "HOSTED_OPERATOR_SESSION_MISMATCH" | "HOSTED_OPERATOR_VIEWER_STALE";
export declare class HostedOperatorBindingError extends Error {
    readonly code: HostedOperatorBindingErrorCode;
    constructor(code: HostedOperatorBindingErrorCode, message: string);
}
/**
 * Structural reference to an operator/viewer session owned by an existing Handoff surface.
 *
 * This is not durable recovery state and does not issue authority. The authoritative operator
 * session implementation remains the existing surface/session manager.
 */
export interface HostedOperatorSessionReference {
    sessionId: string;
    interventionId: string;
    epoch: number;
    principalBinding: string;
    expiresAt: number;
    viewerGeneration: number;
}
export interface HostedOperatorRouteBinding {
    readonly operator: HostedOperatorSessionReference;
    readonly worker: HostedWorkerRouteLease;
}
export declare function parseHostedOperatorSessionReference(value: unknown): HostedOperatorSessionReference;
/**
 * Compose an existing operator session with one current worker route without creating another FSM.
 *
 * The two lifetimes stay independent:
 * - operator TTL / viewer generation come from the surface session manager;
 * - worker connection / worker generation come from HostedWorkerRegistry.
 */
export declare function bindHostedOperatorSession(operatorValue: unknown, worker: HostedWorkerRouteLease, registry: HostedWorkerRegistry, now?: number): HostedOperatorRouteBinding;
/**
 * Revalidate a process-local hosted binding against both authoritative current states.
 *
 * Worker reconnect may rotate only the worker generation while leaving the operator TTL and viewer
 * generation unchanged. Viewer reconnect may rotate only the viewer generation. Neither rotation
 * is accepted by an old binding; the caller must explicitly create a fresh composed binding.
 */
export declare function assertHostedOperatorBindingCurrent(binding: HostedOperatorRouteBinding, currentOperatorValue: unknown, registry: HostedWorkerRegistry, now?: number): void;
//# sourceMappingURL=hosted-operator-binding.d.ts.map