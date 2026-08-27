export const EXECUTION_AUDIT_SCHEMA_VERSION = 1;
export const EXECUTION_AUDIT_EVENT_TYPES = [
    "checkpoint_written",
    "checkpoint_cleared",
    "recovery_requested"
];
export const NOOP_EXECUTION_AUDIT = { record() { } };
const MAX_MEMORY_AUDIT_EVENTS = 256;
const COMMON_KEYS = new Set(["version", "type", "adapterKind", "timestamp"]);
const EVENT_KEYS = {
    checkpoint_written: new Set([...COMMON_KEYS, "interventionId", "epoch", "principalBinding", "actionDigest"]),
    checkpoint_cleared: new Set([...COMMON_KEYS, "principalBinding"]),
    recovery_requested: new Set([...COMMON_KEYS, "interventionId", "epoch", "principalBinding", "actionDigest"])
};
function boundedString(value, min, max) {
    return typeof value === "string" && value.length >= min && value.length <= max && !/[\0\r\n]/.test(value);
}
function validCommon(record) {
    return record.version === EXECUTION_AUDIT_SCHEMA_VERSION
        && EXECUTION_AUDIT_EVENT_TYPES.includes(record.type)
        && boundedString(record.adapterKind, 1, 80)
        && Number.isSafeInteger(record.timestamp)
        && Number(record.timestamp) >= 0;
}
/** Strict parser for the stable v1 audit shape. Extra/free-form fields fail closed. */
export function parseExecutionAuditEvent(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid execution audit event");
    const record = value;
    if (!validCommon(record))
        throw new Error("Invalid execution audit event");
    const type = record.type;
    if (Object.keys(record).some((key) => !EVENT_KEYS[type].has(key)))
        throw new Error("Invalid execution audit event");
    if (type === "checkpoint_cleared") {
        if (record.principalBinding !== undefined && !boundedString(record.principalBinding, 16, 160)) {
            throw new Error("Invalid execution audit event");
        }
        return {
            version: 1,
            type,
            adapterKind: record.adapterKind,
            timestamp: record.timestamp,
            ...(record.principalBinding === undefined ? {} : { principalBinding: record.principalBinding })
        };
    }
    if (!(boundedString(record.interventionId, 1, 160)
        && Number.isSafeInteger(record.epoch) && Number(record.epoch) >= 0
        && boundedString(record.principalBinding, 16, 160)
        && (record.actionDigest === undefined || boundedString(record.actionDigest, 16, 160)))) {
        throw new Error("Invalid execution audit event");
    }
    return {
        version: 1,
        type,
        adapterKind: record.adapterKind,
        timestamp: record.timestamp,
        interventionId: record.interventionId,
        epoch: record.epoch,
        principalBinding: record.principalBinding,
        ...(record.actionDigest === undefined ? {} : { actionDigest: record.actionDigest })
    };
}
export class MemoryExecutionAuditSink {
    events = [];
    record(event) {
        this.events.push(parseExecutionAuditEvent(event));
        if (this.events.length > MAX_MEMORY_AUDIT_EVENTS) {
            this.events.splice(0, this.events.length - MAX_MEMORY_AUDIT_EVENTS);
        }
    }
    snapshot() {
        return this.events.map((event) => ({ ...event }));
    }
}
//# sourceMappingURL=audit.js.map