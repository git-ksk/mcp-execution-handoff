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
    now;
    providerKind;
    state = { kind: "idle" };
    constructor(provider, now = Date.now) {
        this.provider = provider;
        this.now = now;
        const normalized = provider.kind.trim();
        if (!normalized || normalized.length > 80) {
            throw new ExternalHumanSurfaceError("EXTERNAL_SURFACE_PROVIDER_INVALID", "external Human surface provider kind must contain 1-80 characters");
        }
        this.providerKind = normalized;
    }
    getActive() {
        const state = this.state;
        if (state.kind !== "active" || this.isExpired(state.surface))
            return undefined;
        return { ...state.surface };
    }
    assertInactive() {
        if (this.state.kind === "idle")
            return;
        throw new ExternalHumanSurfaceError("EXTERNAL_SURFACE_ACTIVE", "External Human surface authority is not confirmed inactive; complete provider cleanup before restoring automation authority");
    }
    async begin(intervention, principalBinding) {
        this.assertCredentialSafeEntryState(intervention);
        this.assertPrincipalBinding(principalBinding);
        const request = this.requestFor(intervention, principalBinding);
        const state = this.state;
        if (state.kind === "starting") {
            if (!this.matchesRequest(state.request, request)) {
                throw new ExternalHumanSurfaceError("EXTERNAL_SURFACE_ACTIVE", "Another credential-safe external Human surface is already starting");
            }
            const active = await state.promise;
            return { ...active };
        }
        if (state.kind === "cleanup_required") {
            const matches = this.matchesRequest(state.request, request);
            const reason = state.reason;
            await this.retryCleanupForBegin(state);
            throw new ExternalHumanSurfaceError(matches && reason === "expired" ? "EXTERNAL_SURFACE_EXPIRED" : "EXTERNAL_SURFACE_STATE_CHANGED", matches && reason === "expired"
                ? "The cached credential-safe external Human surface expired; begin a fresh Human surface explicitly"
                : "The previous credential-safe external Human surface requires cleanup before a fresh surface can begin");
        }
        if (state.kind === "active") {
            const cached = state.surface;
            if (this.isExpired(cached)) {
                const matches = this.matches(cached, intervention, principalBinding);
                const cleanup = this.makeCleanup(cached, "expired");
                this.state = cleanup;
                await this.retryCleanupForBegin(cleanup);
                throw new ExternalHumanSurfaceError(matches ? "EXTERNAL_SURFACE_EXPIRED" : "EXTERNAL_SURFACE_STATE_CHANGED", matches
                    ? "The cached credential-safe external Human surface expired; begin a fresh Human surface explicitly"
                    : "The expired credential-safe external Human surface belonged to another intervention, epoch, or principal");
            }
            if (this.matches(cached, intervention, principalBinding))
                return { ...cached };
            throw new ExternalHumanSurfaceError("EXTERNAL_SURFACE_ACTIVE", "Another credential-safe external Human surface is already active");
        }
        const starting = {
            kind: "starting",
            request
        };
        this.state = starting;
        const promise = this.startProviderSurface(starting, intervention, principalBinding);
        starting.promise = promise;
        const active = await promise;
        return { ...active };
    }
    async revoke(interventionId, epoch, principalBinding) {
        const request = { interventionId, epoch, principalBinding };
        const state = this.state;
        if (state.kind === "starting") {
            if (!this.matchesRequest(state.request, request)) {
                throw this.stateChangedError();
            }
            try {
                await state.promise;
            }
            catch {
                if (this.state.kind === "idle")
                    return;
            }
            return this.revoke(interventionId, epoch, principalBinding);
        }
        if (state.kind === "active") {
            if (!this.matchesIdentity(state.surface, interventionId, epoch, principalBinding)) {
                throw this.stateChangedError();
            }
            const cleanup = this.makeCleanup(state.surface, this.isExpired(state.surface) ? "expired" : "revocation");
            this.state = cleanup;
            await this.performCleanup(cleanup);
            return;
        }
        if (state.kind === "cleanup_required") {
            if (!this.matchesRequest(state.request, request)) {
                throw this.stateChangedError();
            }
            await this.performCleanup(state);
            return;
        }
        throw this.stateChangedError();
    }
    async startProviderSurface(starting, intervention, principalBinding) {
        let grant;
        try {
            grant = await this.provider.begin(starting.request);
        }
        catch (error) {
            if (this.state === starting)
                this.state = { kind: "idle" };
            throw error;
        }
        let active;
        try {
            active = this.normalizeGrant(grant, intervention, principalBinding);
        }
        catch (error) {
            const cleanup = {
                kind: "cleanup_required",
                request: starting.request,
                sessionId: grant.sessionId,
                reason: error instanceof ExternalHumanSurfaceError && error.code === "EXTERNAL_SURFACE_EXPIRED"
                    ? "expired"
                    : "invalid_grant"
            };
            this.state = cleanup;
            try {
                await this.performCleanup(cleanup);
            }
            catch {
                // Keep cleanup ownership and report the original grant error to the caller.
            }
            throw error;
        }
        if (this.state !== starting) {
            const cleanup = {
                kind: "cleanup_required",
                request: starting.request,
                sessionId: active.sessionId,
                reason: "invalid_grant"
            };
            this.state = cleanup;
            try {
                await this.performCleanup(cleanup);
            }
            catch {
                // The runtime remains fail-closed in cleanup_required on revoke failure.
            }
            throw this.stateChangedError();
        }
        this.state = { kind: "active", surface: active };
        return active;
    }
    async retryCleanupForBegin(cleanup) {
        try {
            await this.performCleanup(cleanup);
        }
        catch {
            // begin() preserves expiry/state-change semantics while cleanup_required keeps authority busy.
        }
    }
    async performCleanup(cleanup) {
        if (cleanup.revokePromise) {
            try {
                await cleanup.revokePromise;
            }
            catch {
                throw this.revokeFailedError();
            }
            return;
        }
        const revokePromise = Promise.resolve().then(() => this.provider.revoke(cleanup.sessionId));
        cleanup.revokePromise = revokePromise;
        try {
            await revokePromise;
            if (this.state === cleanup)
                this.state = { kind: "idle" };
        }
        catch {
            if (this.state === cleanup)
                delete cleanup.revokePromise;
            throw this.revokeFailedError();
        }
    }
    makeCleanup(active, reason) {
        return {
            kind: "cleanup_required",
            request: {
                interventionId: active.interventionId,
                epoch: active.epoch,
                principalBinding: active.principalBinding
            },
            sessionId: active.sessionId,
            reason
        };
    }
    requestFor(intervention, principalBinding) {
        return {
            interventionId: intervention.id,
            epoch: intervention.epoch,
            principalBinding
        };
    }
    stateChangedError() {
        return new ExternalHumanSurfaceError("EXTERNAL_SURFACE_STATE_CHANGED", "The credential-safe external Human surface no longer matches this intervention, epoch, and principal");
    }
    revokeFailedError() {
        return new ExternalHumanSurfaceError("EXTERNAL_SURFACE_REVOKE_FAILED", "External Human surface provider revocation was not confirmed; cleanup must succeed before automation authority can resume");
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
        if (grant.expiresAt !== undefined && grant.expiresAt <= this.now()) {
            throw new ExternalHumanSurfaceError("EXTERNAL_SURFACE_EXPIRED", "external Human surface provider returned an already-expired surface");
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
    isExpired(active) {
        return active.expiresAt !== undefined && active.expiresAt <= this.now();
    }
    matches(active, intervention, principalBinding) {
        return this.matchesIdentity(active, intervention.id, intervention.epoch, principalBinding);
    }
    matchesIdentity(active, interventionId, epoch, principalBinding) {
        return active.interventionId === interventionId
            && active.epoch === epoch
            && this.same(active.principalBinding, principalBinding);
    }
    matchesRequest(left, right) {
        return left.interventionId === right.interventionId
            && left.epoch === right.epoch
            && this.same(left.principalBinding, right.principalBinding);
    }
    same(left, right) {
        const expected = Buffer.from(left, "utf8");
        const supplied = Buffer.from(right, "utf8");
        return expected.length === supplied.length && timingSafeEqual(expected, supplied);
    }
}
//# sourceMappingURL=human-surface.js.map