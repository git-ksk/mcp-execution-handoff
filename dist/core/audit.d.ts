export declare const EXECUTION_AUDIT_SCHEMA_VERSION: 1;
export declare const EXECUTION_AUDIT_EVENT_TYPES: readonly ["checkpoint_written", "checkpoint_cleared", "recovery_requested"];
export type ExecutionAuditEventType = (typeof EXECUTION_AUDIT_EVENT_TYPES)[number];
type AuditBase<TType extends ExecutionAuditEventType> = {
    version: typeof EXECUTION_AUDIT_SCHEMA_VERSION;
    type: TType;
    adapterKind: string;
    timestamp: number;
};
export type ExecutionAuditEvent = (AuditBase<"checkpoint_written"> & {
    interventionId: string;
    epoch: number;
    principalBinding: string;
    actionDigest?: string;
}) | (AuditBase<"checkpoint_cleared"> & {
    principalBinding?: string;
}) | (AuditBase<"recovery_requested"> & {
    interventionId: string;
    epoch: number;
    principalBinding: string;
    actionDigest?: string;
});
export interface ExecutionAuditSink {
    /**
     * Synchronous, observe-only delivery. Throwing signals sink failure to Handoff but must never be
     * used by the sink to grant/revoke execution authority or to carry execution content.
     */
    record(event: Readonly<ExecutionAuditEvent>): void;
}
export interface ExecutionAuditSinkFailure {
    version: typeof EXECUTION_AUDIT_SCHEMA_VERSION;
    eventType: ExecutionAuditEventType;
}
export type ExecutionAuditSinkFailureHandler = (failure: Readonly<ExecutionAuditSinkFailure>) => void;
export declare const NOOP_EXECUTION_AUDIT: ExecutionAuditSink;
/** Strict parser for the stable v1 audit shape. Extra/free-form fields fail closed. */
export declare function parseExecutionAuditEvent(value: unknown): ExecutionAuditEvent;
export declare class MemoryExecutionAuditSink implements ExecutionAuditSink {
    private readonly events;
    record(event: Readonly<ExecutionAuditEvent>): void;
    snapshot(): ExecutionAuditEvent[];
}
export {};
//# sourceMappingURL=audit.d.ts.map