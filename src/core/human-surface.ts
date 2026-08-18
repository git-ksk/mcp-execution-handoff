import { timingSafeEqual } from "node:crypto";
import type { ExecutionAuthority, InterventionStatus } from "./lifecycle.js";

export const HUMAN_SURFACE_KINDS = ["automation_adjacent", "credential_safe_external"] as const;
export type HumanSurfaceKind = (typeof HUMAN_SURFACE_KINDS)[number];

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
      | "EXTERNAL_SURFACE_PROVIDER_INVALID",
    message: string
  ) {
    super(message);
    this.name = "ExternalHumanSurfaceError";
  }
}

export function selectHumanSurface<TReason extends string>(
  reason: TReason,
  credentialSafeReasons: ReadonlySet<TReason> | readonly TReason[]
): HumanSurfaceKind {
  const matches = Array.isArray(credentialSafeReasons)
    ? credentialSafeReasons.includes(reason)
    : (credentialSafeReasons as ReadonlySet<TReason>).has(reason);
  return matches ? "credential_safe_external" : "automation_adjacent";
}

export class CredentialSafeHumanSurfaceRuntime {
  private readonly providerKind: string;
  private active: ActiveExternalHumanSurface | undefined;

  constructor(private readonly provider: ExternalHumanSurfaceProvider) {
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
    return this.active ? { ...this.active } : undefined;
  }

  assertInactive(): void {
    if (!this.active) return;
    throw new ExternalHumanSurfaceError(
      "EXTERNAL_SURFACE_ACTIVE",
      `External Human surface ${this.active.sessionId} is still active; revoke it before restoring automation authority`
    );
  }

  async begin(
    intervention: HumanSurfaceInterventionRef,
    principalBinding: string
  ): Promise<ActiveExternalHumanSurface> {
    this.assertCredentialSafeEntryState(intervention);
    this.assertPrincipalBinding(principalBinding);

    if (this.active) {
      if (this.matches(this.active, intervention, principalBinding)) return { ...this.active };
      throw new ExternalHumanSurfaceError(
        "EXTERNAL_SURFACE_ACTIVE",
        "Another credential-safe external Human surface is already active"
      );
    }

    const grant = await this.provider.begin({
      interventionId: intervention.id,
      epoch: intervention.epoch,
      principalBinding
    });
    let active: ActiveExternalHumanSurface;
    try {
      active = this.normalizeGrant(grant, intervention, principalBinding);
    } catch (error) {
      await this.provider.revoke(grant.sessionId).catch(() => undefined);
      throw error;
    }
    this.active = active;
    return { ...active };
  }

  async revoke(
    interventionId: string,
    epoch: number,
    principalBinding: string
  ): Promise<void> {
    const active = this.active;
    if (!active || !this.matchesIdentity(active, interventionId, epoch, principalBinding)) {
      throw new ExternalHumanSurfaceError(
        "EXTERNAL_SURFACE_STATE_CHANGED",
        "The credential-safe external Human surface no longer matches this intervention, epoch, and principal"
      );
    }
    await this.provider.revoke(active.sessionId);
    this.active = undefined;
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

  private same(left: string, right: string): boolean {
    const expected = Buffer.from(left, "utf8");
    const supplied = Buffer.from(right, "utf8");
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  }
}
