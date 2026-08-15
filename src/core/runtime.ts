import { timingSafeEqual } from "node:crypto";
import type { RegisteredExecutionAdapter } from "./adapter.js";
import { NOOP_EXECUTION_AUDIT, type ExecutionAuditSink } from "./audit.js";
import type { InterventionStatus, ResumePolicy } from "./lifecycle.js";
import type { HandoffRecoveryRecord, SignedFileHandoffCheckpointStore } from "./checkpoint.js";
export interface CheckpointableIntervention { id: string; status: InterventionStatus; epoch: number; resumePolicy: ResumePolicy; updatedAt: number; }
export interface ExecutionHandoffRuntimeOptions { checkpointStore?: SignedFileHandoffCheckpointStore; auditSink?: ExecutionAuditSink; checkpointTtlMs?: number; now?: () => number; }
export class ExecutionHandoffRuntime<TIntervention extends CheckpointableIntervention, TResumeDecision> {
  private readonly audit: ExecutionAuditSink; private readonly checkpointTtlMs: number; private readonly now: () => number;
  constructor(readonly adapter: RegisteredExecutionAdapter<TIntervention, TResumeDecision>, private readonly options: ExecutionHandoffRuntimeOptions = {}) {
    this.audit = options.auditSink ?? NOOP_EXECUTION_AUDIT; this.checkpointTtlMs = options.checkpointTtlMs ?? 15 * 60_000; this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.checkpointTtlMs) || this.checkpointTtlMs < 60_000 || this.checkpointTtlMs > 24 * 60 * 60_000) throw new Error("checkpoint ttl must be between 1 minute and 24 hours");
  }
  checkpoint(principalBinding: string, actionDigest?: string): void {
    const store = this.options.checkpointStore; if (!store) return;
    const active = this.adapter.control.getActiveIntervention();
    if (!active) { store.clear(); this.audit.record({ type: "checkpoint_cleared", adapterKind: this.adapter.kind, timestamp: this.now(), principalBinding }); return; }
    const now = this.now();
    try { store.write({ version: 1, adapterKind: this.adapter.kind, interventionId: active.id, status: active.status, epoch: active.epoch, resumePolicy: active.resumePolicy, principalBinding, ...(actionDigest ? { actionDigest } : {}), updatedAt: active.updatedAt, expiresAt: now + this.checkpointTtlMs }); }
    catch (error) { this.adapter.control.cancelHumanIntervention(active.id); throw error; }
    this.audit.record({ type: "checkpoint_written", adapterKind: this.adapter.kind, timestamp: now, interventionId: active.id, epoch: active.epoch, principalBinding, ...(actionDigest ? { actionDigest } : {}) });
  }
  clearCheckpoint(principalBinding?: string): void { this.options.checkpointStore?.clear(); this.audit.record({ type: "checkpoint_cleared", adapterKind: this.adapter.kind, timestamp: this.now(), ...(principalBinding ? { principalBinding } : {}) }); }
  recover(principalBinding: string): HandoffRecoveryRecord | undefined {
    const record = this.options.checkpointStore?.recover(); if (!record) return undefined;
    if (record.adapterKind !== this.adapter.kind || !this.same(record.principalBinding, principalBinding)) return undefined;
    this.audit.record({ type: "recovery_requested", adapterKind: this.adapter.kind, timestamp: this.now(), interventionId: record.interventionId, epoch: record.epoch, principalBinding, ...(record.actionDigest ? { actionDigest: record.actionDigest } : {}) });
    return record;
  }
  private same(left: string, right: string): boolean { const a = Buffer.from(left, "utf8"); const b = Buffer.from(right, "utf8"); return a.length === b.length && timingSafeEqual(a, b); }
}
