import { timingSafeEqual } from "node:crypto";
import { NOOP_EXECUTION_AUDIT } from "./audit.js";
export class ExecutionHandoffRuntime {
    adapter;
    options;
    audit;
    checkpointTtlMs;
    now;
    constructor(adapter, options = {}) {
        this.adapter = adapter;
        this.options = options;
        this.audit = options.auditSink ?? NOOP_EXECUTION_AUDIT;
        this.checkpointTtlMs = options.checkpointTtlMs ?? 15 * 60_000;
        this.now = options.now ?? Date.now;
        if (!Number.isInteger(this.checkpointTtlMs) || this.checkpointTtlMs < 60_000 || this.checkpointTtlMs > 24 * 60 * 60_000)
            throw new Error("checkpoint ttl must be between 1 minute and 24 hours");
    }
    checkpoint(principalBinding, actionDigest) {
        const store = this.options.checkpointStore;
        if (!store)
            return;
        const active = this.adapter.control.getActiveIntervention();
        if (!active) {
            store.clear();
            this.audit.record({ type: "checkpoint_cleared", adapterKind: this.adapter.kind, timestamp: this.now(), principalBinding });
            return;
        }
        const now = this.now();
        try {
            store.write({ version: 1, adapterKind: this.adapter.kind, interventionId: active.id, status: active.status, epoch: active.epoch, resumePolicy: active.resumePolicy, principalBinding, ...(actionDigest ? { actionDigest } : {}), updatedAt: active.updatedAt, expiresAt: now + this.checkpointTtlMs });
        }
        catch (error) {
            this.adapter.control.cancelHumanIntervention(active.id);
            throw error;
        }
        this.audit.record({ type: "checkpoint_written", adapterKind: this.adapter.kind, timestamp: now, interventionId: active.id, epoch: active.epoch, principalBinding, ...(actionDigest ? { actionDigest } : {}) });
    }
    clearCheckpoint(principalBinding) { this.options.checkpointStore?.clear(); this.audit.record({ type: "checkpoint_cleared", adapterKind: this.adapter.kind, timestamp: this.now(), ...(principalBinding ? { principalBinding } : {}) }); }
    recover(principalBinding) {
        const record = this.options.checkpointStore?.recover();
        if (!record)
            return undefined;
        if (record.adapterKind !== this.adapter.kind || !this.same(record.principalBinding, principalBinding))
            return undefined;
        this.audit.record({ type: "recovery_requested", adapterKind: this.adapter.kind, timestamp: this.now(), interventionId: record.interventionId, epoch: record.epoch, principalBinding, ...(record.actionDigest ? { actionDigest: record.actionDigest } : {}) });
        return record;
    }
    same(left, right) { const a = Buffer.from(left, "utf8"); const b = Buffer.from(right, "utf8"); return a.length === b.length && timingSafeEqual(a, b); }
}
//# sourceMappingURL=runtime.js.map