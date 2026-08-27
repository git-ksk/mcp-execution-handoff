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
/**
 * Synchronous durable-store boundary for generic Handoff control-plane checkpoints.
 *
 * `read()` deliberately returns `unknown`: storage providers are persistence mechanisms, not
 * schema or recovery-authority providers. `ExecutionHandoffRuntime` revalidates every loaded value
 * before using it as a recovery hint. All methods complete (or fail) before returning; an async or
 * best-effort store is not compatible with this contract because checkpoint failure can fence
 * active Human authority.
 */
export interface HandoffCheckpointStore {
    write(checkpoint: Readonly<HandoffCheckpoint>): void;
    read(): unknown;
    clear(): void;
}
export declare class HandoffCheckpointError extends Error {
    readonly code: "CHECKPOINT_INVALID" | "CHECKPOINT_EXPIRED";
    constructor(code: "CHECKPOINT_INVALID" | "CHECKPOINT_EXPIRED", message: string);
}
/** Handoff-owned strict schema validation. Extra fields fail closed. */
export declare function parseHandoffCheckpoint(value: unknown): HandoffCheckpoint;
export declare function recoverHandoffCheckpoint(value: unknown, now: number): HandoffRecoveryRecord;
export declare class SignedFileHandoffCheckpointStore implements HandoffCheckpointStore {
    private readonly filePath;
    private readonly signingKey;
    private readonly now;
    constructor(filePath: string, signingKey: Buffer, now?: () => number);
    write(checkpoint: Readonly<HandoffCheckpoint>): void;
    private loadVerified;
    /** Provider-neutral store method: integrity-verified value, with expiry enforced by the runtime. */
    read(): unknown;
    /** Existing local-file compatibility API. */
    load(): HandoffCheckpoint | undefined;
    /** Existing local-file compatibility API. */
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