import {
  browserHandoffTransportAttemptOrder,
  type BrowserHandoffTransportAttempt,
  type BrowserHandoffTransportFallbackPolicy
} from "./transport-fallback-policy.js";

export interface ManagedBrowserHandoffTransportDriver {
  readonly kind: BrowserHandoffTransportAttempt;
  start(generation: number): string | Promise<string>;
  revoke(): void | Promise<void>;
}

export interface ManagedBrowserHandoffTransportLease {
  readonly transport: BrowserHandoffTransportAttempt;
  readonly generation: number;
  readonly locator: string;
}

export class ManagedBrowserHandoffTransportCoordinatorError extends Error {
  constructor(
    public readonly code:
      | "MANAGED_TRANSPORT_PLAN_INVALID"
      | "MANAGED_TRANSPORT_ALREADY_STARTED"
      | "MANAGED_TRANSPORT_NOT_ACTIVE"
      | "MANAGED_TRANSPORT_STALE",
    message: string
  ) {
    super(message);
    this.name = "ManagedBrowserHandoffTransportCoordinatorError";
  }
}

interface ActiveManagedTransport {
  readonly index: number;
  readonly driver: ManagedBrowserHandoffTransportDriver;
  readonly lease: ManagedBrowserHandoffTransportLease;
}

/**
 * Serializes Handoff-owned transport transitions for one Browser/Window intervention.
 *
 * The coordinator carries lifecycle facts only. It never accepts Human input, SDP, ICE material,
 * WebSocket frames, credentials, or consumer provider choices. Before a later transport can start,
 * the currently active driver must finish `revoke()`. Each successful transition receives a fresh
 * logical generation, so concurrent/stale transition requests fail closed rather than claiming two
 * mutable Human authorities.
 */
export class ManagedBrowserHandoffTransportCoordinator {
  readonly #drivers: readonly ManagedBrowserHandoffTransportDriver[];
  #active: ActiveManagedTransport | undefined;
  #started = false;
  #generation = 0;
  #serial: Promise<void> = Promise.resolve();

  constructor(
    policy: BrowserHandoffTransportFallbackPolicy,
    drivers: readonly ManagedBrowserHandoffTransportDriver[]
  ) {
    const expected = browserHandoffTransportAttemptOrder(policy);
    if (
      drivers.length !== expected.length
      || drivers.some((driver, index) => driver.kind !== expected[index])
    ) {
      throw new ManagedBrowserHandoffTransportCoordinatorError(
        "MANAGED_TRANSPORT_PLAN_INVALID",
        "Managed Browser Handoff transport plan is invalid"
      );
    }
    this.#drivers = [...drivers];
  }

  start(): Promise<ManagedBrowserHandoffTransportLease> {
    return this.#enqueue(async () => {
      if (this.#started) {
        throw new ManagedBrowserHandoffTransportCoordinatorError(
          "MANAGED_TRANSPORT_ALREADY_STARTED",
          "Managed Browser Handoff transport is already started"
        );
      }
      this.#started = true;
      return this.#startDriver(0);
    });
  }

  advance(
    lease: Pick<ManagedBrowserHandoffTransportLease, "transport" | "generation">
  ): Promise<ManagedBrowserHandoffTransportLease | undefined> {
    return this.#enqueue(async () => {
      const active = this.#assertActive(lease);
      await active.driver.revoke();
      this.#active = undefined;
      this.#generation += 1;

      const nextIndex = active.index + 1;
      if (nextIndex >= this.#drivers.length) return undefined;
      return this.#startDriver(nextIndex);
    });
  }

  revoke(
    lease?: Pick<ManagedBrowserHandoffTransportLease, "transport" | "generation">
  ): Promise<void> {
    return this.#enqueue(async () => {
      const active = this.#active;
      if (!active) return;
      if (lease) this.#assertActive(lease);
      await active.driver.revoke();
      this.#active = undefined;
      this.#generation += 1;
    });
  }

  snapshot(): ManagedBrowserHandoffTransportLease | undefined {
    return this.#active ? { ...this.#active.lease } : undefined;
  }

  async #startDriver(index: number): Promise<ManagedBrowserHandoffTransportLease> {
    const driver = this.#drivers[index]!;
    const generation = this.#generation + 1;
    let locator: string;
    try {
      locator = await driver.start(generation);
    } catch (error) {
      await Promise.resolve(driver.revoke()).catch(() => undefined);
      this.#generation = generation;
      throw error;
    }
    if (!locator.trim()) {
      await Promise.resolve(driver.revoke()).catch(() => undefined);
      this.#generation = generation;
      throw new ManagedBrowserHandoffTransportCoordinatorError(
        "MANAGED_TRANSPORT_NOT_ACTIVE",
        "Managed Browser Handoff transport did not provide a locator"
      );
    }
    this.#generation = generation;
    const lease = Object.freeze({ transport: driver.kind, generation, locator });
    this.#active = { index, driver, lease };
    return lease;
  }

  #assertActive(
    lease: Pick<ManagedBrowserHandoffTransportLease, "transport" | "generation">
  ): ActiveManagedTransport {
    const active = this.#active;
    if (!active) {
      throw new ManagedBrowserHandoffTransportCoordinatorError(
        "MANAGED_TRANSPORT_NOT_ACTIVE",
        "Managed Browser Handoff transport is unavailable"
      );
    }
    if (
      active.lease.transport !== lease.transport
      || active.lease.generation !== lease.generation
    ) {
      throw new ManagedBrowserHandoffTransportCoordinatorError(
        "MANAGED_TRANSPORT_STALE",
        "Managed Browser Handoff transport generation is stale"
      );
    }
    return active;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#serial.then(operation, operation);
    this.#serial = result.then(() => undefined, () => undefined);
    return result;
  }
}
