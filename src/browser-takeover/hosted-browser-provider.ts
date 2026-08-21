import type {
  ExternalHumanSurfaceGrant,
  ExternalHumanSurfaceProvider,
  ExternalHumanSurfaceRequest
} from "../core/human-surface.js";
import { TakeoverBroker } from "./broker.js";

interface ActiveHostedSurface {
  sessionId: string;
  interventionId: string;
  epoch: number;
  principalBinding: string;
}

export class HostedBrowserTakeoverProvider implements ExternalHumanSurfaceProvider {
  readonly kind = "hosted-browser-takeover";
  private readonly active = new Map<string, ActiveHostedSurface>();

  constructor(private readonly broker: TakeoverBroker) {}

  async begin(request: ExternalHumanSurfaceRequest): Promise<ExternalHumanSurfaceGrant> {
    this.assertRequest(request);
    const locator = this.broker.createLink(
      { id: request.interventionId, epoch: request.epoch },
      request.principalBinding
    );
    if (!locator) throw new Error("Hosted browser takeover broker is unavailable");
    const sessionId = this.sessionIdFromLocator(locator);

    for (const active of this.active.values()) {
      if (active.interventionId !== request.interventionId) continue;
      if (
        active.sessionId === sessionId &&
        active.epoch === request.epoch &&
        active.principalBinding === request.principalBinding
      ) {
        return { sessionId, locator };
      }
      throw new Error("Another hosted browser takeover generation is already active for this intervention");
    }

    this.active.set(sessionId, {
      sessionId,
      interventionId: request.interventionId,
      epoch: request.epoch,
      principalBinding: request.principalBinding
    });
    return { sessionId, locator };
  }

  async revoke(sessionId: string): Promise<void> {
    const active = this.active.get(sessionId);
    if (!active) return;
    this.active.delete(sessionId);
    this.broker.revokeForIntervention(active.interventionId);
  }

  private sessionIdFromLocator(locator: string): string {
    const url = new URL(locator);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2 || parts[0] !== "takeover") {
      throw new Error("Hosted browser takeover broker returned an invalid locator");
    }
    const sessionId = decodeURIComponent(parts[1] ?? "");
    if (!/^[A-Za-z0-9-]{8,100}$/.test(sessionId)) {
      throw new Error("Hosted browser takeover broker returned an invalid session id");
    }
    return sessionId;
  }

  private assertRequest(request: ExternalHumanSurfaceRequest): void {
    if (!request.interventionId || request.interventionId.length > 200) {
      throw new Error("Hosted browser takeover requires a bounded intervention id");
    }
    if (!Number.isSafeInteger(request.epoch) || request.epoch < 0) {
      throw new Error("Hosted browser takeover requires a valid resource epoch");
    }
    if (!request.principalBinding || request.principalBinding.length > 512) {
      throw new Error("Hosted browser takeover requires a bounded principal binding");
    }
  }
}
