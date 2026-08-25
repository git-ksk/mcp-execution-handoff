import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export interface TakeoverLocator {
  id: string;
  interventionId: string;
  epoch: number;
  principalBinding: string;
  expiresAt: number;
}

export interface TakeoverGrant extends TakeoverLocator {
  capability: string;
  reconnectHandle: string;
  clientBinding: string;
  clientGeneration: number;
}

export interface TakeoverCompletionResult extends TakeoverLocator {
  alreadyCompleted: boolean;
}

interface TakeoverRecord extends TakeoverLocator {
  completionExpiresAt: number;
  revoked: boolean;
  completed: boolean;
  clientBinding?: string;
  clientGeneration: number;
  lastSeenAt?: number;
  inFlight: number;
  released: boolean;
}

export class TakeoverSessionError extends Error {
  constructor(
    public readonly code: "TAKEOVER_NOT_FOUND" | "TAKEOVER_EXPIRED" | "TAKEOVER_FORBIDDEN" | "TAKEOVER_CLIENT_ACTIVE",
    message: string
  ) {
    super(message);
    this.name = "TakeoverSessionError";
  }
}

export class TakeoverSessionManager {
  private readonly records = new Map<string, TakeoverRecord>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = randomUUID,
    private readonly signingKey: Buffer = randomBytes(32),
    private readonly reconnectIdleMs: number = Math.min(5_000, Math.max(250, Math.floor(ttlMs / 4))),
    private readonly completionGraceMs: number = ttlMs
  ) {
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000) {
      throw new Error("takeover ttl must be at least 1000ms");
    }
    if (!Number.isInteger(reconnectIdleMs) || reconnectIdleMs < 250 || reconnectIdleMs >= ttlMs) {
      throw new Error("takeover reconnect idle must be at least 250ms and less than the takeover ttl");
    }
    if (!Number.isInteger(completionGraceMs) || completionGraceMs < 1_000 || completionGraceMs > 30 * 60_000) {
      throw new Error("takeover completion grace must be between 1s and 30m");
    }
  }

  ensure(interventionId: string, epoch: number, principalBinding: string): TakeoverLocator {
    this.pruneExpired();
    const now = this.now();
    for (const record of this.records.values()) {
      if (
        !record.revoked &&
        record.expiresAt > now &&
        record.interventionId === interventionId &&
        record.epoch === epoch &&
        record.principalBinding === principalBinding
      ) {
        return this.locator(record);
      }
    }

    // A claimed record whose media/input lease expired may remain only for bounded Human Done.
    // Do not revoke that completion-only record when minting a fresh media locator. Revoke only
    // still-live media/input records for the intervention so two mutable generations never coexist.
    for (const record of this.records.values()) {
      if (record.interventionId === interventionId && record.expiresAt > now) record.revoked = true;
    }
    const record: TakeoverRecord = {
      id: this.createId(),
      interventionId,
      epoch,
      principalBinding,
      expiresAt: now + this.ttlMs,
      completionExpiresAt: now + this.ttlMs + this.completionGraceMs,
      revoked: false,
      completed: false,
      clientGeneration: 0,
      inFlight: 0,
      released: false
    };
    this.records.set(record.id, record);
    return this.locator(record);
  }

  validateLocator(id: string, principalBinding: string): TakeoverLocator {
    const record = this.requireActive(id);
    this.assertPrincipal(record, principalBinding);
    return this.locator(record);
  }

  issueCompletionCapability(id: string, principalBinding: string): string {
    const record = this.records.get(id);
    if (!record || record.revoked) {
      throw new TakeoverSessionError("TAKEOVER_NOT_FOUND", "Takeover session is not active");
    }
    this.assertPrincipal(record, principalBinding);
    if (record.expiresAt <= this.now()) {
      if (!record.clientBinding || record.clientGeneration < 1 || record.completionExpiresAt <= this.now()) {
        throw new TakeoverSessionError("TAKEOVER_EXPIRED", "Takeover session expired");
      }
    }
    return this.completionCapabilityFor(record);
  }

  complete(
    id: string,
    completionCapability: string,
    principalBinding: string
  ): TakeoverCompletionResult {
    const record = this.records.get(id);
    if (!record) throw new TakeoverSessionError("TAKEOVER_NOT_FOUND", "Takeover session is not active");
    if (record.revoked && !record.completed) {
      throw new TakeoverSessionError("TAKEOVER_NOT_FOUND", "Takeover session is not active");
    }
    if (record.expiresAt <= this.now()
      && (!record.clientBinding || record.clientGeneration < 1 || record.completionExpiresAt <= this.now())) {
      throw new TakeoverSessionError("TAKEOVER_EXPIRED", "Takeover session expired");
    }
    this.assertPrincipal(record, principalBinding);
    this.assertCompletionCapabilityShape(completionCapability);
    this.assertCompletionCapability(record, completionCapability);
    const alreadyCompleted = record.completed;
    record.completed = true;
    record.revoked = true;
    record.released = true;
    return { ...this.locator(record), alreadyCompleted };
  }

  claimClient(id: string, principalBinding: string, clientBinding: string): TakeoverGrant {
    const record = this.requireActive(id);
    this.assertPrincipal(record, principalBinding);
    this.assertClientBindingShape(clientBinding);
    if (record.clientBinding === undefined) {
      record.clientBinding = clientBinding;
      record.clientGeneration = 1;
      record.released = false;
    } else if (record.released || !this.same(record.clientBinding, clientBinding)) {
      throw new TakeoverSessionError("TAKEOVER_FORBIDDEN", "Takeover session is unavailable");
    }
    record.lastSeenAt = this.now();
    return this.grant(record);
  }

  reconnectClient(
    id: string,
    principalBinding: string,
    reconnectHandle: string,
    nextClientBinding: string
  ): TakeoverGrant {
    const record = this.requireActive(id);
    this.assertPrincipal(record, principalBinding);
    this.assertClientBindingShape(nextClientBinding);
    this.assertReconnectHandleShape(reconnectHandle);
    if (!record.clientBinding || !record.lastSeenAt || record.clientGeneration < 1) {
      throw new TakeoverSessionError("TAKEOVER_FORBIDDEN", "Takeover session is unavailable");
    }
    if (record.inFlight > 0 || (!record.released && this.now() - record.lastSeenAt < this.reconnectIdleMs)) {
      throw new TakeoverSessionError("TAKEOVER_CLIENT_ACTIVE", "Takeover client is still active");
    }
    this.assertReconnectHandle(record, reconnectHandle);
    record.clientBinding = nextClientBinding;
    record.clientGeneration += 1;
    record.lastSeenAt = this.now();
    record.released = false;
    return this.grant(record);
  }

  releaseClientGeneration(
    id: string,
    principalBinding: string,
    clientBinding: string,
    clientGeneration: number
  ): void {
    const record = this.requireActive(id);
    this.assertPrincipal(record, principalBinding);
    this.assertClient(record, clientBinding);
    if (record.clientGeneration !== clientGeneration) {
      throw new TakeoverSessionError("TAKEOVER_FORBIDDEN", "Takeover generation is stale");
    }
    record.released = true;
  }

  beginBoundUse(
    id: string,
    principalBinding: string,
    clientBinding: string,
    clientGeneration: number
  ): Omit<TakeoverGrant, "capability" | "reconnectHandle"> {
    const record = this.requireActive(id);
    this.assertPrincipal(record, principalBinding);
    this.assertClient(record, clientBinding);
    if (record.released || record.clientGeneration !== clientGeneration) {
      throw new TakeoverSessionError("TAKEOVER_FORBIDDEN", "Takeover generation is stale");
    }
    record.inFlight += 1;
    record.lastSeenAt = this.now();
    return {
      ...this.locator(record),
      clientBinding: record.clientBinding!,
      clientGeneration: record.clientGeneration
    };
  }

  beginUse(
    id: string,
    capability: string,
    principalBinding: string,
    clientBinding: string
  ): Omit<TakeoverGrant, "capability" | "reconnectHandle"> {
    const grant = this.verify(id, capability, principalBinding, clientBinding);
    const record = this.requireActive(id);
    record.inFlight += 1;
    return grant;
  }

  endUse(
    id: string,
    principalBinding: string,
    clientBinding: string,
    clientGeneration: number
  ): void {
    const record = this.records.get(id);
    if (!record || record.revoked) return;
    if (record.expiresAt <= this.now()) return;
    if (
      !this.same(record.principalBinding, principalBinding) ||
      !record.clientBinding ||
      !this.same(record.clientBinding, clientBinding) ||
      record.clientGeneration !== clientGeneration
    ) {
      return;
    }
    record.inFlight = Math.max(0, record.inFlight - 1);
    record.lastSeenAt = this.now();
  }

  verify(
    id: string,
    capability: string,
    principalBinding: string,
    clientBinding: string
  ): Omit<TakeoverGrant, "capability" | "reconnectHandle"> {
    const record = this.requireActive(id);
    this.assertPrincipal(record, principalBinding);
    this.assertClient(record, clientBinding);
    if (record.released) {
      throw new TakeoverSessionError("TAKEOVER_FORBIDDEN", "Takeover generation is stale");
    }
    const expected = Buffer.from(this.capabilityFor(record), "utf8");
    const supplied = Buffer.from(capability, "utf8");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      throw new TakeoverSessionError("TAKEOVER_FORBIDDEN", "Takeover capability is invalid");
    }
    record.lastSeenAt = this.now();

    return {
      ...this.locator(record),
      clientBinding: record.clientBinding!,
      clientGeneration: record.clientGeneration
    };
  }

  revoke(id: string): void {
    const record = this.records.get(id);
    if (record) record.revoked = true;
  }

  revokeForIntervention(interventionId: string): void {
    for (const record of this.records.values()) {
      if (record.interventionId === interventionId) record.revoked = true;
    }
  }

  private requireActive(id: string): TakeoverRecord {
    const record = this.records.get(id);
    if (!record || record.revoked) {
      throw new TakeoverSessionError("TAKEOVER_NOT_FOUND", "Takeover session is not active");
    }
    if (record.expiresAt <= this.now()) {
      throw new TakeoverSessionError("TAKEOVER_EXPIRED", "Takeover session expired");
    }
    return record;
  }

  private assertPrincipal(record: TakeoverRecord, principalBinding: string): void {
    if (!this.same(record.principalBinding, principalBinding)) {
      throw new TakeoverSessionError("TAKEOVER_FORBIDDEN", "Takeover session is unavailable");
    }
  }

  private assertClient(record: TakeoverRecord, clientBinding: string): void {
    this.assertClientBindingShape(clientBinding);
    if (!record.clientBinding || !this.same(record.clientBinding, clientBinding)) {
      throw new TakeoverSessionError("TAKEOVER_FORBIDDEN", "Takeover session is unavailable");
    }
  }

  private assertClientBindingShape(clientBinding: string): void {
    if (!/^[A-Za-z0-9_-]{24,128}$/.test(clientBinding)) {
      throw new TakeoverSessionError("TAKEOVER_FORBIDDEN", "Takeover session is unavailable");
    }
  }

  private assertReconnectHandleShape(reconnectHandle: string): void {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(reconnectHandle)) {
      throw new TakeoverSessionError("TAKEOVER_FORBIDDEN", "Takeover reconnect handle is invalid");
    }
  }

  private assertReconnectHandle(record: TakeoverRecord, reconnectHandle: string): void {
    const expected = Buffer.from(this.reconnectHandleFor(record), "utf8");
    const supplied = Buffer.from(reconnectHandle, "utf8");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      throw new TakeoverSessionError("TAKEOVER_FORBIDDEN", "Takeover reconnect handle is invalid");
    }
  }

  private assertCompletionCapabilityShape(completionCapability: string): void {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(completionCapability)) {
      throw new TakeoverSessionError("TAKEOVER_FORBIDDEN", "Takeover completion capability is invalid");
    }
  }

  private assertCompletionCapability(record: TakeoverRecord, completionCapability: string): void {
    const expected = Buffer.from(this.completionCapabilityFor(record), "utf8");
    const supplied = Buffer.from(completionCapability, "utf8");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      throw new TakeoverSessionError("TAKEOVER_FORBIDDEN", "Takeover completion capability is invalid");
    }
  }

  private same(left: string, right: string): boolean {
    const expected = Buffer.from(left, "utf8");
    const supplied = Buffer.from(right, "utf8");
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  }

  private locator(record: TakeoverRecord): TakeoverLocator {
    return {
      id: record.id,
      interventionId: record.interventionId,
      epoch: record.epoch,
      principalBinding: record.principalBinding,
      expiresAt: record.expiresAt
    };
  }

  private grant(record: TakeoverRecord): TakeoverGrant {
    if (!record.clientBinding || record.clientGeneration < 1) {
      throw new TakeoverSessionError("TAKEOVER_FORBIDDEN", "Takeover client has not claimed the session");
    }
    return {
      ...this.locator(record),
      capability: this.capabilityFor(record),
      reconnectHandle: this.reconnectHandleFor(record),
      clientBinding: record.clientBinding,
      clientGeneration: record.clientGeneration
    };
  }

  private capabilityFor(record: TakeoverRecord): string {
    if (!record.clientBinding || record.clientGeneration < 1) {
      throw new TakeoverSessionError("TAKEOVER_FORBIDDEN", "Takeover client has not claimed the session");
    }
    return createHmac("sha256", this.signingKey)
      .update("mcp-execution-handoff/takeover/v2\0")
      .update(record.id)
      .update("\0")
      .update(record.interventionId)
      .update("\0")
      .update(String(record.epoch))
      .update("\0")
      .update(record.principalBinding)
      .update("\0")
      .update(record.clientBinding)
      .update("\0")
      .update(String(record.clientGeneration))
      .update("\0")
      .update(String(record.expiresAt))
      .digest("base64url");
  }

  private completionCapabilityFor(record: TakeoverRecord): string {
    return createHmac("sha256", this.signingKey)
      .update("mcp-execution-handoff/takeover-completion/v1\0")
      .update(record.id)
      .update("\0")
      .update(record.interventionId)
      .update("\0")
      .update(String(record.epoch))
      .update("\0")
      .update(record.principalBinding)
      .update("\0")
      .update(String(record.expiresAt))
      .update("\0")
      .update(String(record.completionExpiresAt))
      .digest("base64url");
  }

  private reconnectHandleFor(record: TakeoverRecord): string {
    if (!record.clientBinding || record.clientGeneration < 1) {
      throw new TakeoverSessionError("TAKEOVER_FORBIDDEN", "Takeover client has not claimed the session");
    }
    return createHmac("sha256", this.signingKey)
      .update("mcp-execution-handoff/takeover-reconnect/v1\0")
      .update(record.id)
      .update("\0")
      .update(record.interventionId)
      .update("\0")
      .update(String(record.epoch))
      .update("\0")
      .update(record.principalBinding)
      .update("\0")
      .update(record.clientBinding)
      .update("\0")
      .update(String(record.clientGeneration))
      .update("\0")
      .update(String(record.expiresAt))
      .digest("base64url");
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [id, record] of this.records) {
      const claimed = !!record.clientBinding && record.clientGeneration > 0;
      if ((record.revoked && !record.completed)
        || (!claimed && record.expiresAt <= now)
        || (claimed && record.completionExpiresAt <= now)) {
        this.records.delete(id);
      }
    }
  }
}
