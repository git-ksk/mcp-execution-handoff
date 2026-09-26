import type { ResumePolicy } from "./lifecycle.js";
export interface HostedControlPlaneRecoveryHint {
    version: 1;
    interventionId: string;
    epoch: number;
    principalBinding: string;
    resumePolicy: ResumePolicy;
    actionDigest?: string;
    recovery: "reissue_and_revalidate";
    workerRoute: "reconnect_required";
    operatorSession: "reissue_required";
}
/**
 * Project the existing v0.3 checkpoint into hosted recovery orchestration.
 *
 * Hosted recovery deliberately does not restore worker identity/generation, channel binding,
 * operator session id/generation, locator/capability, frame/input state, or any target/session
 * content. A worker must authenticate again and an operator session must be freshly issued before
 * hosted delivery can resume.
 */
export declare function recoverHostedControlPlane(value: unknown, now: number): HostedControlPlaneRecoveryHint;
//# sourceMappingURL=hosted-recovery.d.ts.map