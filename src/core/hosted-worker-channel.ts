import {
  HostedWorkerRegistry,
  HostedWorkerRegistryError,
  type HostedWorkerRegistration,
  type HostedWorkerRegistrationRequest,
  type HostedWorkerRouteLease,
  type HostedWorkerRouteRequest
} from "./hosted-worker.js";

export const HOSTED_WORKER_CONTROL_PROTOCOL_VERSION = 1 as const;

export type HostedWorkerControlMessage =
  | {
      version: typeof HOSTED_WORKER_CONTROL_PROTOCOL_VERSION;
      type: "registered";
      workerGeneration: number;
    }
  | {
      version: typeof HOSTED_WORKER_CONTROL_PROTOCOL_VERSION;
      type: "bind";
      interventionId: string;
      epoch: number;
      workerGeneration: number;
    }
  | {
      version: typeof HOSTED_WORKER_CONTROL_PROTOCOL_VERSION;
      type: "revoke";
      interventionId: string;
      epoch: number;
      workerGeneration: number;
    };

export interface HostedWorkerControlPeer {
  send(message: Readonly<HostedWorkerControlMessage>): void | Promise<void>;
  close?(): void | Promise<void>;
}

export type HostedWorkerRouteInvalidationReason =
  | "bind_delivery_failure"
  | "explicit_revoke"
  | "revoke_delivery_failure"
  | "worker_disconnect";

export interface HostedWorkerControlChannelHooks {
  routesInvalidated?(
    routes: readonly Readonly<HostedWorkerRouteLease>[],
    reason: HostedWorkerRouteInvalidationReason
  ): void | Promise<void>;
}

export class HostedWorkerControlChannelError extends Error {
  constructor(
    public readonly code:
      | "HOSTED_WORKER_CHANNEL_UNAVAILABLE"
      | "HOSTED_WORKER_CHANNEL_CLOSED"
      | "HOSTED_WORKER_REVOCATION_PROPAGATION_FAILED",
    message: string
  ) {
    super(message);
    this.name = "HostedWorkerControlChannelError";
  }
}

/**
 * Provider-neutral control-plane side of an authenticated outbound worker channel.
 *
 * The deployment transport authenticates the worker first and supplies a trusted
 * HostedWorkerRegistrationRequest. No worker/principal identity is accepted from peer messages.
 * This class owns only bounded control messages; frame data, Human input and credentials are not
 * part of this protocol.
 */
export class HostedWorkerControlChannel {
  readonly #registration: HostedWorkerRegistration;
  readonly #channelBinding: string;
  #closed = false;

  private constructor(
    private readonly registry: HostedWorkerRegistry,
    authenticated: HostedWorkerRegistrationRequest,
    private readonly peer: HostedWorkerControlPeer,
    private readonly hooks: HostedWorkerControlChannelHooks = {}
  ) {
    this.#channelBinding = authenticated.channelBinding;
    this.#registration = this.registry.register(authenticated);
  }

  static async open(
    registry: HostedWorkerRegistry,
    authenticated: HostedWorkerRegistrationRequest,
    peer: HostedWorkerControlPeer,
    hooks: HostedWorkerControlChannelHooks = {}
  ): Promise<HostedWorkerControlChannel> {
    const channel = new HostedWorkerControlChannel(registry, authenticated, peer, hooks);
    try {
      await peer.send({
        version: HOSTED_WORKER_CONTROL_PROTOCOL_VERSION,
        type: "registered",
        workerGeneration: channel.#registration.generation
      });
    } catch {
      channel.#fenceLocal();
      await channel.#closePeerBestEffort();
      throw new HostedWorkerControlChannelError(
        "HOSTED_WORKER_CHANNEL_UNAVAILABLE",
        "Hosted worker control channel registration delivery failed"
      );
    }
    return channel;
  }

  registration(): HostedWorkerRegistration {
    return { ...this.#registration };
  }

  async bindIntervention(
    request: Omit<HostedWorkerRouteRequest, "workerId" | "workerGeneration">
  ): Promise<HostedWorkerRouteLease> {
    this.#assertOpen();
    const route = this.registry.bindIntervention({
      ...request,
      workerId: this.#registration.workerId,
      workerGeneration: this.#registration.generation
    });
    try {
      await this.peer.send({
        version: HOSTED_WORKER_CONTROL_PROTOCOL_VERSION,
        type: "bind",
        interventionId: route.interventionId,
        epoch: route.epoch,
        workerGeneration: route.workerGeneration
      });
    } catch {
      const revoked = this.#fenceLocal();
      const propagationFailed = !(await this.#notifyInvalidated(
        revoked,
        "bind_delivery_failure"
      ));
      await this.#closePeerBestEffort();
      if (propagationFailed) {
        throw new HostedWorkerControlChannelError(
          "HOSTED_WORKER_REVOCATION_PROPAGATION_FAILED",
          "Hosted worker route invalidation propagation failed"
        );
      }
      throw new HostedWorkerControlChannelError(
        "HOSTED_WORKER_CHANNEL_UNAVAILABLE",
        "Hosted worker control bind delivery failed"
      );
    }
    return route;
  }

  assertCurrent(route: HostedWorkerRouteLease): void {
    this.#assertOpen();
    this.registry.assertCurrent(route);
    if (route.workerId !== this.#registration.workerId
      || route.workerGeneration !== this.#registration.generation) {
      throw new HostedWorkerRegistryError(
        "HOSTED_WORKER_STALE_GENERATION",
        "Hosted worker route does not belong to this channel"
      );
    }
  }

  async revokeIntervention(route: HostedWorkerRouteLease): Promise<void> {
    this.#assertOpen();
    this.assertCurrent(route);
    // Fence local delivery before attempting either propagation path. Neither an operator-surface
    // callback failure nor a remote worker notification failure may restore routing authority.
    this.registry.releaseIntervention(route);
    const propagationOk = await this.#notifyInvalidated([route], "explicit_revoke");

    let deliveryFailed = false;
    try {
      await this.peer.send({
        version: HOSTED_WORKER_CONTROL_PROTOCOL_VERSION,
        type: "revoke",
        interventionId: route.interventionId,
        epoch: route.epoch,
        workerGeneration: route.workerGeneration
      });
    } catch {
      deliveryFailed = true;
      const additionallyRevoked = this.#fenceLocal();
      await this.#notifyInvalidated(additionallyRevoked, "revoke_delivery_failure");
      await this.#closePeerBestEffort();
    }

    if (!propagationOk) {
      throw new HostedWorkerControlChannelError(
        "HOSTED_WORKER_REVOCATION_PROPAGATION_FAILED",
        "Hosted worker route invalidation propagation failed"
      );
    }
    if (deliveryFailed) {
      throw new HostedWorkerControlChannelError(
        "HOSTED_WORKER_CHANNEL_UNAVAILABLE",
        "Hosted worker control revoke delivery failed"
      );
    }
  }

  async disconnect(): Promise<HostedWorkerRouteLease[]> {
    if (this.#closed) return [];
    const revoked = this.#fenceLocal();
    const propagationOk = await this.#notifyInvalidated(revoked, "worker_disconnect");
    await this.#closePeerBestEffort();
    if (!propagationOk) {
      throw new HostedWorkerControlChannelError(
        "HOSTED_WORKER_REVOCATION_PROPAGATION_FAILED",
        "Hosted worker route invalidation propagation failed"
      );
    }
    return revoked;
  }

  #fenceLocal(): HostedWorkerRouteLease[] {
    if (this.#closed) return [];
    this.#closed = true;
    return this.registry.disconnect(
      this.#registration.workerId,
      this.#registration.generation,
      this.#channelBinding
    );
  }

  async #notifyInvalidated(
    routes: readonly HostedWorkerRouteLease[],
    reason: HostedWorkerRouteInvalidationReason
  ): Promise<boolean> {
    if (routes.length === 0 || !this.hooks.routesInvalidated) return true;
    try {
      await this.hooks.routesInvalidated(
        routes.map((route) => ({ ...route })),
        reason
      );
      return true;
    } catch {
      return false;
    }
  }

  async #closePeerBestEffort(): Promise<void> {
    try {
      await this.peer.close?.();
    } catch {
      // Local worker generation and every bound route are already fenced. Transport close failure
      // cannot restore authority and is intentionally not allowed to mask the stronger local state.
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new HostedWorkerControlChannelError(
        "HOSTED_WORKER_CHANNEL_CLOSED",
        "Hosted worker control channel is closed"
      );
    }
  }
}
