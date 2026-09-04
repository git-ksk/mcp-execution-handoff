import type { ExecutionAuthority, InterventionStatus } from "./lifecycle.js";
export declare const HUMAN_INTERACTION_POLICY_KINDS: readonly ["automation_adjacent", "credential_safe_external"];
export type HumanInteractionPolicyKind = (typeof HUMAN_INTERACTION_POLICY_KINDS)[number];
/** @deprecated Use HUMAN_INTERACTION_POLICY_KINDS. Kept for source/runtime compatibility. */
export declare const HUMAN_SURFACE_KINDS: readonly ["automation_adjacent", "credential_safe_external"];
/** @deprecated Use HumanInteractionPolicyKind. Kept for source compatibility. */
export type HumanSurfaceKind = HumanInteractionPolicyKind;
export interface HumanSurfaceInterventionRef {
    id: string;
    epoch: number;
    status: InterventionStatus;
    authority: Exclude<ExecutionAuthority, "agent">;
}
export interface ExternalHumanSurfaceRequest {
    interventionId: string;
    epoch: number;
    principalBinding: string;
}
export interface ExternalHumanSurfaceGrant {
    sessionId: string;
    locator: string;
    expiresAt?: number;
}
export interface ExternalHumanSurfaceProvider {
    readonly kind: string;
    begin(request: ExternalHumanSurfaceRequest): Promise<ExternalHumanSurfaceGrant>;
    revoke(sessionId: string): Promise<void>;
}
export interface ActiveExternalHumanSurface extends ExternalHumanSurfaceRequest {
    providerKind: string;
    sessionId: string;
    locator: string;
    expiresAt?: number;
}
export declare class ExternalHumanSurfaceError extends Error {
    readonly code: "EXTERNAL_SURFACE_STATE_CHANGED" | "EXTERNAL_SURFACE_ACTIVE" | "EXTERNAL_SURFACE_EXPIRED" | "EXTERNAL_SURFACE_PROVIDER_INVALID";
    constructor(code: "EXTERNAL_SURFACE_STATE_CHANGED" | "EXTERNAL_SURFACE_ACTIVE" | "EXTERNAL_SURFACE_EXPIRED" | "EXTERNAL_SURFACE_PROVIDER_INVALID", message: string);
}
export declare function selectHumanInteractionPolicy<TReason extends string>(reason: TReason, credentialSafeReasons: ReadonlySet<TReason> | readonly TReason[]): HumanInteractionPolicyKind;
/**
 * @deprecated Use selectHumanInteractionPolicy(). This alias remains source/runtime compatible
 * until an intentional breaking release after consumers have migrated.
 */
export declare function selectHumanSurface<TReason extends string>(reason: TReason, credentialSafeReasons: ReadonlySet<TReason> | readonly TReason[]): HumanSurfaceKind;
export declare class CredentialSafeHumanSurfaceRuntime {
    private readonly provider;
    private readonly now;
    private readonly providerKind;
    private active;
    constructor(provider: ExternalHumanSurfaceProvider, now?: () => number);
    getActive(): ActiveExternalHumanSurface | undefined;
    assertInactive(): void;
    begin(intervention: HumanSurfaceInterventionRef, principalBinding: string): Promise<ActiveExternalHumanSurface>;
    revoke(interventionId: string, epoch: number, principalBinding: string): Promise<void>;
    private assertCredentialSafeEntryState;
    private assertPrincipalBinding;
    private normalizeGrant;
    private isExpired;
    private matches;
    private matchesIdentity;
    private same;
}
//# sourceMappingURL=human-surface.d.ts.map