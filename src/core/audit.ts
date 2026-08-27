export const EXECUTION_AUDIT_SCHEMA_VERSION = 1 as const;
export const EXECUTION_AUDIT_EVENT_TYPES = [
  "checkpoint_written",
  "checkpoint_cleared",
  "recovery_requested"
] as const;
export type ExecutionAuditEventType = (typeof EXECUTION_AUDIT_EVENT_TYPES)[number];

type AuditBase<TType extends ExecutionAuditEventType> = {
  version: typeof EXECUTION_AUDIT_SCHEMA_VERSION;
  type: TType;
  adapterKind: string;
  timestamp: number;
};

export type ExecutionAuditEvent =
  | (AuditBase<"checkpoint_written"> & {
      interventionId: string;
      epoch: number;
      principalBinding: string;
      actionDigest?: string;
    })
  | (AuditBase<"checkpoint_cleared"> & {
      principalBinding?: string;
    })
  | (AuditBase<"recovery_requested"> & {
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

export const NOOP_EXECUTION_AUDIT: ExecutionAuditSink = { record() {} };

const MAX_MEMORY_AUDIT_EVENTS = 256;
const COMMON_KEYS = new Set(["version", "type", "adapterKind", "timestamp"]);
const EVENT_KEYS: Record<ExecutionAuditEventType, ReadonlySet<string>> = {
  checkpoint_written: new Set([...COMMON_KEYS, "interventionId", "epoch", "principalBinding", "actionDigest"]),
  checkpoint_cleared: new Set([...COMMON_KEYS, "principalBinding"]),
  recovery_requested: new Set([...COMMON_KEYS, "interventionId", "epoch", "principalBinding", "actionDigest"])
};

function boundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max && !/[\0\r\n]/.test(value);
}

function validCommon(record: Record<string, unknown>): boolean {
  return record.version === EXECUTION_AUDIT_SCHEMA_VERSION
    && EXECUTION_AUDIT_EVENT_TYPES.includes(record.type as ExecutionAuditEventType)
    && boundedString(record.adapterKind, 1, 80)
    && Number.isSafeInteger(record.timestamp)
    && Number(record.timestamp) >= 0;
}

/** Strict parser for the stable v1 audit shape. Extra/free-form fields fail closed. */
export function parseExecutionAuditEvent(value: unknown): ExecutionAuditEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid execution audit event");
  const record = value as Record<string, unknown>;
  if (!validCommon(record)) throw new Error("Invalid execution audit event");
  const type = record.type as ExecutionAuditEventType;
  if (Object.keys(record).some((key) => !EVENT_KEYS[type].has(key))) throw new Error("Invalid execution audit event");

  if (type === "checkpoint_cleared") {
    if (record.principalBinding !== undefined && !boundedString(record.principalBinding, 16, 160)) {
      throw new Error("Invalid execution audit event");
    }
    return {
      version: 1,
      type,
      adapterKind: record.adapterKind as string,
      timestamp: record.timestamp as number,
      ...(record.principalBinding === undefined ? {} : { principalBinding: record.principalBinding as string })
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
    adapterKind: record.adapterKind as string,
    timestamp: record.timestamp as number,
    interventionId: record.interventionId as string,
    epoch: record.epoch as number,
    principalBinding: record.principalBinding as string,
    ...(record.actionDigest === undefined ? {} : { actionDigest: record.actionDigest as string })
  };
}

export class MemoryExecutionAuditSink implements ExecutionAuditSink {
  private readonly events: ExecutionAuditEvent[] = [];

  record(event: Readonly<ExecutionAuditEvent>): void {
    this.events.push(parseExecutionAuditEvent(event));
    if (this.events.length > MAX_MEMORY_AUDIT_EVENTS) {
      this.events.splice(0, this.events.length - MAX_MEMORY_AUDIT_EVENTS);
    }
  }

  snapshot(): ExecutionAuditEvent[] {
    return this.events.map((event) => ({ ...event }));
  }
}
