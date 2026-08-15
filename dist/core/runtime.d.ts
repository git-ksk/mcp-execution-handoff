import type { RegisteredExecutionAdapter } from "./adapter.js";
import { type ExecutionAuditSink } from "./audit.js";
import type { InterventionStatus, ResumePolicy } from "./lifecycle.js";
import type { HandoffRecoveryRecord, SignedFileHandoffCheckpointStore } from "./checkpoint.js";
export interface CheckpointableIntervention {
    id: string;
    status: InterventionStatus;
    epoch: number;
    resumePolicy: ResumePolicy;
    updatedAt: number;
}
export interface ExecutionHandoffRuntimeOptions {
    checkpointStore?: SignedFileHandoffCheckpointStore;
    auditSink?: ExecutionAuditSink;
    checkpointTtlMs?: number;
    now?: () => number;
}
export declare class ExecutionHandoffRuntime<TIntervention extends CheckpointableIntervention, TResumeDecision> {
    readonly adapter: RegisteredExecutionAdapter<TIntervention, TResumeDecision>;
    private readonly options;
    private readonly audit;
    private readonly checkpointTtlMs;
    private readonly now;
    constructor(adapter: RegisteredExecutionAdapter<TIntervention, TResumeDecision>, options?: ExecutionHandoffRuntimeOptions);
    checkpoint(principalBinding: string, actionDigest?: string): void;
    clearCheckpoint(principalBinding?: string): void;
    recover(principalBinding: string): HandoffRecoveryRecord | undefined;
    private same;
}
//# sourceMappingURL=runtime.d.ts.map