import { timingSafeEqual } from "node:crypto";
export const HUMAN_INTERACTION_POLICY_KINDS = [
    "automation_adjacent",
    "credential_safe_external"
];
/** @deprecated Use HUMAN_INTERACTION_POLICY_KINDS. Kept for source/runtime compatibility. */
export const HUMAN_SURFACE_KINDS = HUMAN_INTERACTION_POLICY_KINDS;
export class ExternalHumanSurfaceError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "ExternalHumanSurfaceError";
    }
}
export function selectHumanInteractionPolicy(reason, credentialSafeReasons) {
    const matches = Array.isArray(credentialSafeReasons)
        ? credentialSafeReasons.includes(reason)
        : credentialSafeReasons.has(reason);
    return matches ? "credential_safe_external" : "automation_adjacent";
}
/**
 * @deprecated Use selectHumanInteractionPolicy(). This alias remains source/runtime compatible
 * until an intentional breaking release after consumers have migrated.
 */
export function selectHumanSurface(reason, credentialSafeReasons) {
    return selectHumanInteractionPolicy(reason, credentialSafeReasons);
}
export class CredentialSafeHumanSurfaceRuntime {
    provider;
    providerKind;
    active;
    constructor(provider) {
        this.provider = provider;
        const normalized = provider.kind.trim();
        if (!normalized || normalized.length > 80) {
            throw new ExternalHumanSurfaceError("EXTERNAL_SURFACE_PROVIDER_INVALID", "external Human surface provider kind must contain 1-80 characters");
        }
        this.providerKind = normalized;
    }
    getActive() {
        return this.active ? { ...this.active } : undefined;
    }
    assertInactive() {
        if (!this.active)
            return;
        throw new ExternalHumanSurfaceError("EXTERNAL_SURFACE_ACTIVE", `External Human surface ${this.active.sessionId} is still active; revoke it before restoring automation authority`);
    }
    async begin(intervention, principalBinding) {
        this.assertCredentialSafeEntryState(intervention);
        this.assertPrincipalBinding(principalBinding);
        if (this.active) {
            if (this.matches(this.active, intervention, principalBinding))
                return { ...this.active };
            throw new ExternalHumanSurfaceError("EXTERNAL_SURFACE_ACTIVE", "Another credential-safe external Human surface is already active");
        }
        const grant = await this.provider.begin({
            interventionId: intervention.id,
            epoch: intervention.epoch,
            principalBinding
        });
        let active;
        try {
            active = this.normalizeGrant(grant, intervention, principalBinding);
        }
        catch (error) {
            await this.provider.revoke(grant.sessionId).catch(() => undefined);
            throw error;
        }
        this.active = active;
        return { ...active };
    }
    async revoke(interventionId, epoch, principalBinding) {
        const active = this.active;
        if (!active || !this.matchesIdentity(active, interventionId, epoch, principalBinding)) {
            throw new ExternalHumanSurfaceError("EXTERNAL_SURFACE_STATE_CHANGED", "The credential-safe external Human surface no longer matches this intervention, epoch, and principal");
        }
        await this.provider.revoke(active.sessionId);
        this.active = undefined;
    }
    assertCredentialSafeEntryState(intervention) {
        if (intervention.status !== "human_active" || intervention.authority !== "human") {
            throw new ExternalHumanSurfaceError("EXTERNAL_SURFACE_STATE_CHANGED", "Credential-safe external Human control may begin only after agent authority is suspended and Human authority is active");
        }
    }
    assertPrincipalBinding(value) {
        if (!value || value.length > 512) {
            throw new ExternalHumanSurfaceError("EXTERNAL_SURFACE_STATE_CHANGED", "principal binding must contain 1-512 characters");
        }
    }
    normalizeGrant(grant, intervention, principalBinding) {
        const sessionId = grant.sessionId.trim();
        const locator = grant.locator.trim();
        if (!sessionId || sessionId.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(sessionId)) {
            throw new ExternalHumanSurfaceError("EXTERNAL_SURFACE_PROVIDER_INVALID", "external Human surface provider returned an invalid session id");
        }
        if (!locator || locator.length > 2_048 || /[\r\n]/.test(locator)) {
            throw new ExternalHumanSurfaceError("EXTERNAL_SURFACE_PROVIDER_INVALID", "external Human surface provider returned an invalid operator locator");
        }
        if (grant.expiresAt !== undefined && (!Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= 0)) {
            throw new ExternalHumanSurfaceError("EXTERNAL_SURFACE_PROVIDER_INVALID", "external Human surface provider returned an invalid expiry");
        }
        return {
            providerKind: this.providerKind,
            interventionId: intervention.id,
            epoch: intervention.epoch,
            principalBinding,
            sessionId,
            locator,
            ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt })
        };
    }
    matches(active, intervention, principalBinding) {
        return this.matchesIdentity(active, intervention.id, intervention.epoch, principalBinding);
    }
    matchesIdentity(active, interventionId, epoch, principalBinding) {
        return active.interventionId === interventionId
            && active.epoch === epoch
            && this.same(active.principalBinding, principalBinding);
    }
    same(left, right) {
        const expected = Buffer.from(left, "utf8");
        const supplied = Buffer.from(right, "utf8");
        return expected.length === supplied.length && timingSafeEqual(expected, supplied);
    }
}
//# sourceMappingURL=human-surface.js.map