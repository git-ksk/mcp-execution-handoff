import type { InterventionStatus, ResumePolicy } from "./lifecycle.js";
export interface HandoffCheckpoint {
    version: 1;
    adapterKind: string;
    interventionId: string;
    status: InterventionStatus;
    epoch: number;
    resumePolicy: ResumePolicy;
    principalBinding: string;
    actionDigest?: string;
    updatedAt: number;
    expiresAt: number;
}
export interface HandoffRecoveryRecord extends HandoffCheckpoint {
    recovery: "reissue_and_revalidate";
}
export declare class HandoffCheckpointError extends Error {
    readonly code: "CHECKPOINT_INVALID" | "CHECKPOINT_EXPIRED";
    constructor(code: "CHECKPOINT_INVALID" | "CHECKPOINT_EXPIRED", message: string);
}
export declare class SignedFileHandoffCheckpointStore {
    private readonly filePath;
    private readonly signingKey;
    private readonly now;
    constructor(filePath: string, signingKey: Buffer, now?: () => number);
    write(checkpoint: HandoffCheckpoint): void;
    private loadVerified;
    load(): HandoffCheckpoint | undefined;
    recover(): HandoffRecoveryRecord | undefined;
    /**
     * Read a MAC-verified checkpoint for an explicit local operator revalidation flow even after its
     * normal recovery TTL elapsed. This never restores Agent or Human authority; consumers must
     * independently prove the original owner binding and reissue/revalidate before any resume.
     */
    recoverForOperatorRevalidation(): HandoffRecoveryRecord | undefined;
    clear(): void;
    private mac;
}
//# sourceMappingURL=checkpoint.d.ts.map