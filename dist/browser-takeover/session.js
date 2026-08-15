import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
export class TakeoverSessionError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "TakeoverSessionError";
    }
}
export class TakeoverSessionManager {
    ttlMs;
    now;
    createId;
    signingKey;
    records = new Map();
    constructor(ttlMs, now = Date.now, createId = randomUUID, signingKey = randomBytes(32)) {
        this.ttlMs = ttlMs;
        this.now = now;
        this.createId = createId;
        this.signingKey = signingKey;
        if (!Number.isInteger(ttlMs) || ttlMs < 1_000) {
            throw new Error("takeover ttl must be at least 1000ms");
        }
    }
    ensure(interventionId, epoch, principalBinding) {
        this.pruneExpired();
        for (const record of this.records.values()) {
            if (!record.revoked &&
                record.interventionId === interventionId &&
                record.epoch === epoch &&
                record.principalBinding === principalBinding) {
                return this.locator(record);
            }
        }
        this.revokeForIntervention(interventionId);
        const record = {
            id: this.createId(),
            interventionId,
            epoch,
            principalBinding,
            expiresAt: this.now() + this.ttlMs,
            revoked: false
        };
        this.records.set(record.id, record);
        return this.locator(record);
    }
    validateLocator(id, principalBinding) {
        const record = this.requireActive(id);
        this.assertPrincipal(record, principalBinding);
        return this.locator(record);
    }
    claimClient(id, principalBinding, clientBinding) {
        const record = this.requireActive(id);
        this.assertPrincipal(record, principalBinding);
        this.assertClientBindingShape(clientBinding);
        if (record.clientBinding === undefined) {
            record.clientBinding = clientBinding;
        }
        else if (!this.same(record.clientBinding, clientBinding)) {
            throw new TakeoverSessionError("TAKEOVER_FORBIDDEN", "Takeover session is unavailable");
        }
        return this.grant(record);
    }
    verify(id, capability, principalBinding, clientBinding) {
        const record = this.requireActive(id);
        this.assertPrincipal(record, principalBinding);
        this.assertClient(record, clientBinding);
        const expected = Buffer.from(this.capabilityFor(record), "utf8");
        const supplied = Buffer.from(capability, "utf8");
        if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
            throw new TakeoverSessionError("TAKEOVER_FORBIDDEN", "Takeover capability is invalid");
        }
        return {
            ...this.locator(record),
            clientBinding: record.clientBinding
        };
    }
    revoke(id) {
        const record = this.records.get(id);
        if (record)
            record.revoked = true;
    }
    revokeForIntervention(interventionId) {
        for (const record of this.records.values()) {
            if (record.interventionId === interventionId)
                record.revoked = true;
        }
    }
    requireActive(id) {
        const record = this.records.get(id);
        if (!record || record.revoked) {
            throw new TakeoverSessionError("TAKEOVER_NOT_FOUND", "Takeover session is not active");
        }
        if (record.expiresAt <= this.now()) {
            record.revoked = true;
            throw new TakeoverSessionError("TAKEOVER_EXPIRED", "Takeover session expired");
        }
        return record;
    }
    assertPrincipal(record, principalBinding) {
        if (!this.same(record.principalBinding, principalBinding)) {
            throw new TakeoverSessionError("TAKEOVER_FORBIDDEN", "Takeover session is unavailable");
        }
    }
    assertClient(record, clientBinding) {
        this.assertClientBindingShape(clientBinding);
        if (!record.clientBinding || !this.same(record.clientBinding, clientBinding)) {
            throw new TakeoverSessionError("TAKEOVER_FORBIDDEN", "Takeover session is unavailable");
        }
    }
    assertClientBindingShape(clientBinding) {
        if (!/^[A-Za-z0-9_-]{24,128}$/.test(clientBinding)) {
            throw new TakeoverSessionError("TAKEOVER_FORBIDDEN", "Takeover session is unavailable");
        }
    }
    same(left, right) {
        const expected = Buffer.from(left, "utf8");
        const supplied = Buffer.from(right, "utf8");
        return expected.length === supplied.length && timingSafeEqual(expected, supplied);
    }
    locator(record) {
        return {
            id: record.id,
            interventionId: record.interventionId,
            epoch: record.epoch,
            principalBinding: record.principalBinding,
            expiresAt: record.expiresAt
        };
    }
    grant(record) {
        if (!record.clientBinding) {
            throw new TakeoverSessionError("TAKEOVER_FORBIDDEN", "Takeover client has not claimed the session");
        }
        return {
            ...this.locator(record),
            capability: this.capabilityFor(record),
            clientBinding: record.clientBinding
        };
    }
    capabilityFor(record) {
        if (!record.clientBinding) {
            throw new TakeoverSessionError("TAKEOVER_FORBIDDEN", "Takeover client has not claimed the session");
        }
        return createHmac("sha256", this.signingKey)
            .update("mcp-execution-handoff/takeover/v1\0")
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
            .update(String(record.expiresAt))
            .digest("base64url");
    }
    pruneExpired() {
        const now = this.now();
        for (const [id, record] of this.records) {
            if (record.revoked || record.expiresAt <= now)
                this.records.delete(id);
        }
    }
}
//# sourceMappingURL=session.js.map