export type ExecutionAuditEventType = "checkpoint_written" | "checkpoint_cleared" | "recovery_requested";
export interface ExecutionAuditEvent {
    type: ExecutionAuditEventType;
    adapterKind: string;
    timestamp: number;
    interventionId?: string;
    epoch?: number;
    principalBinding?: string;
    actionDigest?: string;
}
export interface ExecutionAuditSink {
    record(event: ExecutionAuditEvent): void;
}
export declare const NOOP_EXECUTION_AUDIT: ExecutionAuditSink;
export declare class MemoryExecutionAuditSink implements ExecutionAuditSink {
    private readonly events;
    record(event: ExecutionAuditEvent): void;
    snapshot(): ExecutionAuditEvent[];
}
//# sourceMappingURL=audit.d.ts.map