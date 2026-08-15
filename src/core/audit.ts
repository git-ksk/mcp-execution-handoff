export type ExecutionAuditEventType = "checkpoint_written" | "checkpoint_cleared" | "recovery_requested";
export interface ExecutionAuditEvent { type: ExecutionAuditEventType; adapterKind: string; timestamp: number; interventionId?: string; epoch?: number; principalBinding?: string; actionDigest?: string; }
export interface ExecutionAuditSink { record(event: ExecutionAuditEvent): void; }
export const NOOP_EXECUTION_AUDIT: ExecutionAuditSink = { record() {} };
export class MemoryExecutionAuditSink implements ExecutionAuditSink {
  private readonly events: ExecutionAuditEvent[] = [];
  record(event: ExecutionAuditEvent): void { this.events.push({ ...event }); }
  snapshot(): ExecutionAuditEvent[] { return this.events.map((event) => ({ ...event })); }
}
