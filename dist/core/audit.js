export const NOOP_EXECUTION_AUDIT = { record() { } };
export class MemoryExecutionAuditSink {
    events = [];
    record(event) { this.events.push({ ...event }); }
    snapshot() { return this.events.map((event) => ({ ...event })); }
}
//# sourceMappingURL=audit.js.map