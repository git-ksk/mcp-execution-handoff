import { timingSafeEqual } from "node:crypto";
import type { ExecutionAuthority, InterventionStatus } from "./lifecycle.js";

export const HUMAN_INTERACTION_POLICY_KINDS = [
  "automation_adjacent",
  "credential_safe_external"
] as const;
export type HumanInteractionPolicyKind = (typeof HUMAN_INTERACTION_POLICY_KINDS)[number];

/** @deprecated Use HUMAN_INTERACTION_POLICY_KINDS. Kept for source/runtime compatibility. */
export const HUMAN_SURFACE_KINDS = HUMAN_INTERACTION_POLICY_KINDS;
/** @deprecated Use HumanInteractionPolicyKind. Kept for source compatibility. */
export type HumanSurfaceKind = HumanInteractionPolicyKind;

export interface HumanSurfaceInterventionRef {
  id: string;
  epoch: number;
  status: InterventionStatus;
  authority: Exclude<ExecutionAuthority, "agent">;
}

export interface ExternalHumanSurfaceRequest {
  interventionId: string;
  epoch: number;
  principalBinding: string;
}

export interface ExternalHumanSurfaceGrant {
  sessionId: string;
  locator: string;
  expiresAt?: number;
}

export interface ExternalHumanSurfaceProvider {
  readonly kind: string;
  begin(request: ExternalHumanSurfaceRequest): Promise<ExternalHumanSurfaceGrant>;
  revoke(sessionId: string): Promise<void>;
}

export interface ActiveExternalHumanSurface extends ExternalHumanSurfaceRequest {
  providerKind: string;
  sessionId: string;
  locator: string;
  expiresAt?: number;
}

export class ExternalHumanSurfaceError extends Error {
  constructor(
    public readonly code:
      | "EXTERNAL_SURFACE_STATE_CHANGED"
      | "EXTERNAL_SURFACE_ACTIVE"
      | "EXTERNAL_SURFACE_EXPIRED"
      | "EXTERNAL_SURFACE_PROVIDER_INVALID"
      | "EXTERNAL_SURFACE_REVOKE_FAILED",
    message: string
  ) {
    super(message);
    this.name = "ExternalHumanSurfaceError";
  }
}

export function selectHumanInteractionPolicy<TReason extends string>(
  reason: TReason,
  credentialSafeReasons: ReadonlySet<TReason> | readonly TReason[]
): HumanInteractionPolicyKind {
  const matches = Array.isArray(credentialSafeReasons)
    ? credentialSafeReasons.includes(reason)
    : (credentialSafeReasons as ReadonlySet<TReason>).has(reason);
  return matches ? "credential_safe_external" : "automation_adjacent";
}

/**
 * @deprecated Use selectHumanInteractionPolicy(). This alias remains source/runtime compatible
 * until an intentional breaking release after consumers have migrated.
 */
export function selectHumanSurface<TReason extends string>(
  reason: TReason,
  credentialSafeReasons: ReadonlySet<TReason> | readonly TReason[]
): HumanSurfaceKind {
  return selectHumanInteractionPolicy(reason, credentialSafeReasons);
}

type ExternalHumanSurfaceCleanupReason = "expired" | "invalid_grant" | "revocation";

type ExternalHumanSurfaceRuntimeState =
  | { kind: "idle" }
  | {
      kind: "starting";
      request: ExternalHumanSurfaceRequest;
      promise?: Promise<ActiveExternalHumanSurface>;
    }
  | { kind: "active"; surface: ActiveExternalHumanSurface }
  | {
      kind: "cleanup_required";
      request: ExternalHumanSurfaceRequest;
      sessionId: string;
      reason: ExternalHumanSurfaceCleanupReason;
      revokePromise?: Promise<void>;
    };

export class CredentialSafeHumanSurfaceRuntime {
  private readonly providerKind: string;
  private state: ExternalHumanSurfaceRuntimeState = { kind: "idle" };

  constructor(
    private readonly provider: ExternalHumanSurfaceProvider,
    private readonly now: () => number = Date.now
  ) {
    const normalized = provider.kind.trim();
    if (!normalized || normalized.length > 80) {
      throw new ExternalHumanSurfaceError(
        "EXTERNAL_SURFACE_PROVIDER_INVALID",
        "external Human surface provider kind must contain 1-80 characters"
      );
    }
    this.providerKind = normalized;
  }

  getActive(): ActiveExternalHumanSurface | undefined {
    const state = this.state;
    if (state.kind !== "active" || this.isExpired(state.surface)) return undefined;
    return { ...state.surface };
  }

  assertInactive(): void {
    if (this.state.kind === "idle") return;
    throw new ExternalHumanSurfaceError(
      "EXTERNAL_SURFACE_ACTIVE",
      "External Human surface authority is not confirmed inactive; complete provider cleanup before restoring automation authority"
    );
  }

  async begin(
    intervention: HumanSurfaceInterventionRef,
    principalBinding: string
  ): Promise<ActiveExternalHumanSurface> {
    this.assertCredentialSafeEntryState(intervention);
    this.assertPrincipalBinding(principalBinding);
    const request = this.requestFor(intervention, principalBinding);
    const state = this.state;

    if (state.kind === "starting") {
      if (!this.matchesRequest(state.request, request)) {
        throw new ExternalHumanSurfaceError(
          "EXTERNAL_SURFACE_ACTIVE",
          "Another credential-safe external Human surface is already starting"
        );
      }
      const active = await state.promise!;
      return { ...active };
    }

    if (state.kind === "cleanup_required") {
      const matches = this.matchesRequest(state.request, request);
      const reason = state.reason;
      await this.retryCleanupForBegin(state);
      throw new ExternalHumanSurfaceError(
        matches && reason === "expired" ? "EXTERNAL_SURFACE_EXPIRED" : "EXTERNAL_SURFACE_STATE_CHANGED",
        matches && reason === "expired"
          ? "The cached credential-safe external Human surface expired; begin a fresh Human surface explicitly"
          : "The previous credential-safe external Human surface requires cleanup before a fresh surface can begin"
      );
    }

    if (state.kind === "active") {
      const cached = state.surface;
      if (this.isExpired(cached)) {
        const matches = this.matches(cached, intervention, principalBinding);
        const cleanup = this.makeCleanup(cached, "expired");
        this.state = cleanup;
        await this.retryCleanupForBegin(cleanup);
        throw new ExternalHumanSurfaceError(
          matches ? "EXTERNAL_SURFACE_EXPIRED" : "EXTERNAL_SURFACE_STATE_CHANGED",
          matches
            ? "The cached credential-safe external Human surface expired; begin a fresh Human surface explicitly"
            : "The expired credential-safe external Human surface belonged to another intervention, epoch, or principal"
        );
      }
      if (this.matches(cached, intervention, principalBinding)) return { ...cached };
      throw new ExternalHumanSurfaceError(
        "EXTERNAL_SURFACE_ACTIVE",
        "Another credential-safe external Human surface is already active"
      );
    }

    const starting: Extract<ExternalHumanSurfaceRuntimeState, { kind: "starting" }> = {
      kind: "starting",
      request
    };
    this.state = starting;
    const promise = this.startProviderSurface(starting, intervention, principalBinding);
    starting.promise = promise;
    const active = await promise;
    return { ...active };
  }

  async revoke(
    interventionId: string,
    epoch: number,
    principalBinding: string
  ): Promise<void> {
    const request: ExternalHumanSurfaceRequest = { interventionId, epoch, principalBinding };
    const state = this.state;

    if (state.kind === "starting") {
      if (!this.matchesRequest(state.request, request)) {
        throw this.stateChangedError();
      }
      try {
        await state.promise!;
      } catch {
        if (this.state.kind === "idle") return;
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

  private async startProviderSurface(
    starting: Extract<ExternalHumanSurfaceRuntimeState, { kind: "starting" }>,
    intervention: HumanSurfaceInterventionRef,
    principalBinding: string
  ): Promise<ActiveExternalHumanSurface> {
    let grant: ExternalHumanSurfaceGrant;
    try {
      grant = await this.provider.begin(starting.request);
    } catch (error) {
      if (this.state === starting) this.state = { kind: "idle" };
      throw error;
    }

    let active: ActiveExternalHumanSurface;
    try {
      active = this.normalizeGrant(grant, intervention, principalBinding);
    } catch (error) {
      const cleanup: Extract<ExternalHumanSurfaceRuntimeState, { kind: "cleanup_required" }> = {
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
      } catch {
        // Keep cleanup ownership and report the original grant error to the caller.
      }
      throw error;
    }

    if (this.state !== starting) {
      const cleanup: Extract<ExternalHumanSurfaceRuntimeState, { kind: "cleanup_required" }> = {
        kind: "cleanup_required",
        request: starting.request,
        sessionId: active.sessionId,
        reason: "invalid_grant"
      };
      this.state = cleanup;
      try {
        await this.performCleanup(cleanup);
      } catch {
        // The runtime remains fail-closed in cleanup_required on revoke failure.
      }
      throw this.stateChangedError();
    }

    this.state = { kind: "active", surface: active };
    return active;
  }

  private async retryCleanupForBegin(
    cleanup: Extract<ExternalHumanSurfaceRuntimeState, { kind: "cleanup_required" }>
  ): Promise<void> {
    try {
      await this.performCleanup(cleanup);
    } catch {
      // begin() preserves expiry/state-change semantics while cleanup_required keeps authority busy.
    }
  }

  private async performCleanup(
    cleanup: Extract<ExternalHumanSurfaceRuntimeState, { kind: "cleanup_required" }>
  ): Promise<void> {
    if (cleanup.revokePromise) {
      try {
        await cleanup.revokePromise;
      } catch {
        throw this.revokeFailedError();
      }
      return;
    }

    const revokePromise = Promise.resolve().then(() => this.provider.revoke(cleanup.sessionId));
    cleanup.revokePromise = revokePromise;
    try {
      await revokePromise;
      if (this.state === cleanup) this.state = { kind: "idle" };
    } catch {
      if (this.state === cleanup) delete cleanup.revokePromise;
      throw this.revokeFailedError();
    }
  }

  private makeCleanup(
    active: ActiveExternalHumanSurface,
    reason: ExternalHumanSurfaceCleanupReason
  ): Extract<ExternalHumanSurfaceRuntimeState, { kind: "cleanup_required" }> {
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

  private requestFor(
    intervention: HumanSurfaceInterventionRef,
    principalBinding: string
  ): ExternalHumanSurfaceRequest {
    return {
      interventionId: intervention.id,
      epoch: intervention.epoch,
      principalBinding
    };
  }

  private stateChangedError(): ExternalHumanSurfaceError {
    return new ExternalHumanSurfaceError(
      "EXTERNAL_SURFACE_STATE_CHANGED",
      "The credential-safe external Human surface no longer matches this intervention, epoch, and principal"
    );
  }

  private revokeFailedError(): ExternalHumanSurfaceError {
    return new ExternalHumanSurfaceError(
      "EXTERNAL_SURFACE_REVOKE_FAILED",
      "External Human surface provider revocation was not confirmed; cleanup must succeed before automation authority can resume"
    );
  }

  private assertCredentialSafeEntryState(intervention: HumanSurfaceInterventionRef): void {
    if (intervention.status !== "human_active" || intervention.authority !== "human") {
      throw new ExternalHumanSurfaceError(
        "EXTERNAL_SURFACE_STATE_CHANGED",
        "Credential-safe external Human control may begin only after agent authority is suspended and Human authority is active"
      );
    }
  }

  private assertPrincipalBinding(value: string): void {
    if (!value || value.length > 512) {
      throw new ExternalHumanSurfaceError(
        "EXTERNAL_SURFACE_STATE_CHANGED",
        "principal binding must contain 1-512 characters"
      );
    }
  }

  private normalizeGrant(
    grant: ExternalHumanSurfaceGrant,
    intervention: HumanSurfaceInterventionRef,
    principalBinding: string
  ): ActiveExternalHumanSurface {
    const sessionId = grant.sessionId.trim();
    const locator = grant.locator.trim();
    if (!sessionId || sessionId.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(sessionId)) {
      throw new ExternalHumanSurfaceError(
        "EXTERNAL_SURFACE_PROVIDER_INVALID",
        "external Human surface provider returned an invalid session id"
      );
    }
    if (!locator || locator.length > 2_048 || /[\r\n]/.test(locator)) {
      throw new ExternalHumanSurfaceError(
        "EXTERNAL_SURFACE_PROVIDER_INVALID",
        "external Human surface provider returned an invalid operator locator"
      );
    }
    if (grant.expiresAt !== undefined && (!Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= 0)) {
      throw new ExternalHumanSurfaceError(
        "EXTERNAL_SURFACE_PROVIDER_INVALID",
        "external Human surface provider returned an invalid expiry"
      );
    }
    if (grant.expiresAt !== undefined && grant.expiresAt <= this.now()) {
      throw new ExternalHumanSurfaceError(
        "EXTERNAL_SURFACE_EXPIRED",
        "external Human surface provider returned an already-expired surface"
      );
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

  private isExpired(active: ActiveExternalHumanSurface): boolean {
    return active.expiresAt !== undefined && active.expiresAt <= this.now();
  }

  private matches(
    active: ActiveExternalHumanSurface,
    intervention: HumanSurfaceInterventionRef,
    principalBinding: string
  ): boolean {
    return this.matchesIdentity(active, intervention.id, intervention.epoch, principalBinding);
  }

  private matchesIdentity(
    active: ActiveExternalHumanSurface,
    interventionId: string,
    epoch: number,
    principalBinding: string
  ): boolean {
    return active.interventionId === interventionId
      && active.epoch === epoch
      && this.same(active.principalBinding, principalBinding);
  }

  private matchesRequest(left: ExternalHumanSurfaceRequest, right: ExternalHumanSurfaceRequest): boolean {
    return left.interventionId === right.interventionId
      && left.epoch === right.epoch
      && this.same(left.principalBinding, right.principalBinding);
  }

  private same(left: string, right: string): boolean {
    const expected = Buffer.from(left, "utf8");
    const supplied = Buffer.from(right, "utf8");
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  }
}
