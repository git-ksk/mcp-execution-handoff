import {
  browserHandoffTransportAttemptOrder,
  type BrowserHandoffTransportAttempt,
  type BrowserHandoffTransportFallbackPolicy
} from "./transport-fallback-policy.js";

export type ManagedBrowserHandoffFallbackReason = "transport_unavailable";

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

export interface ManagedBrowserHandoffTransportSnapshot {
  readonly currentTransport: BrowserHandoffTransportAttempt | "none";
  readonly lastTransport: BrowserHandoffTransportAttempt | "none";
  readonly previousTransport: BrowserHandoffTransportAttempt | "none";
  readonly generation: number;
  readonly transitionCount: number;
  readonly lastFallbackReason?: ManagedBrowserHandoffFallbackReason;
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
  #transitionCount = 0;
  #lastTransport: BrowserHandoffTransportAttempt | "none" = "none";
  #previousTransport: BrowserHandoffTransportAttempt | "none" = "none";
  #lastFallbackReason: ManagedBrowserHandoffFallbackReason | undefined;
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

  /**
   * Synchronous first-attempt entry used by the existing synchronous Browser/Window `start()` API.
   * Managed facade drivers are required to mint locators synchronously; network readiness remains a
   * later bounded transport concern. Async drivers must use `start()` instead and fail closed here.
   */
  startSync(): ManagedBrowserHandoffTransportLease {
    if (this.#started) {
      throw new ManagedBrowserHandoffTransportCoordinatorError(
        "MANAGED_TRANSPORT_ALREADY_STARTED",
        "Managed Browser Handoff transport is already started"
      );
    }
    this.#started = true;
    return this.#startDriverSync(0);
  }

  advance(
    lease: Pick<ManagedBrowserHandoffTransportLease, "transport" | "generation">
  ): Promise<ManagedBrowserHandoffTransportLease | undefined> {
    return this.#enqueue(async () => {
      const active = this.#assertActive(lease);
      await active.driver.revoke();
      this.#previousTransport = active.lease.transport;
      this.#active = undefined;

      const nextIndex = active.index + 1;
      if (nextIndex >= this.#drivers.length) {
        this.#generation += 1;
        return undefined;
      }
      return this.#startDriver(nextIndex);
    });
  }

  /**
   * Advance after a bounded transport failure. Failed later transports are fully revoked before the
   * next staged attempt is considered, so WSS unavailability may reach optional TURN without ever
   * leaving two mutable Human transports active at once.
   */
  fallback(
    lease: Pick<ManagedBrowserHandoffTransportLease, "transport" | "generation">,
    reason: ManagedBrowserHandoffFallbackReason
  ): Promise<ManagedBrowserHandoffTransportLease | undefined> {
    return this.#enqueue(async () => {
      const active = this.#assertActive(lease);
      await active.driver.revoke();
      this.#previousTransport = active.lease.transport;
      this.#active = undefined;
      this.#lastFallbackReason = reason;

      const firstNextIndex = active.index + 1;
      if (firstNextIndex >= this.#drivers.length) {
        this.#transitionCount += 1;
        this.#generation += 1;
        return undefined;
      }

      for (let index = firstNextIndex; index < this.#drivers.length; index += 1) {
        this.#transitionCount += 1;
        try {
          return await this.#startDriver(index);
        } catch {
          // #startDriver fences the failed attempt before returning control here.
        }
      }
      return undefined;
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
      this.#previousTransport = active.lease.transport;
      this.#active = undefined;
      this.#generation += 1;
    });
  }

  snapshot(): ManagedBrowserHandoffTransportLease | undefined {
    return this.#active ? { ...this.#active.lease } : undefined;
  }

  diagnosticsSnapshot(): ManagedBrowserHandoffTransportSnapshot {
    return {
      currentTransport: this.#active?.lease.transport ?? "none",
      lastTransport: this.#lastTransport,
      previousTransport: this.#previousTransport,
      generation: this.#generation,
      transitionCount: this.#transitionCount,
      ...(this.#lastFallbackReason === undefined
        ? {}
        : { lastFallbackReason: this.#lastFallbackReason })
    };
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
    return this.#activate(index, driver, generation, locator);
  }

  #startDriverSync(index: number): ManagedBrowserHandoffTransportLease {
    const driver = this.#drivers[index]!;
    const generation = this.#generation + 1;
    let locator: string;
    try {
      const result = driver.start(generation);
      if (isPromiseLike(result)) {
        void Promise.resolve(driver.revoke()).catch(() => undefined);
        this.#generation = generation;
        throw new ManagedBrowserHandoffTransportCoordinatorError(
          "MANAGED_TRANSPORT_PLAN_INVALID",
          "Managed Browser Handoff synchronous start requires a synchronous locator driver"
        );
      }
      locator = result;
    } catch (error) {
      void Promise.resolve(driver.revoke()).catch(() => undefined);
      this.#generation = generation;
      throw error;
    }
    return this.#activate(index, driver, generation, locator);
  }

  #activate(
    index: number,
    driver: ManagedBrowserHandoffTransportDriver,
    generation: number,
    locator: string
  ): ManagedBrowserHandoffTransportLease {
    if (!locator.trim()) {
      void Promise.resolve(driver.revoke()).catch(() => undefined);
      this.#generation = generation;
      throw new ManagedBrowserHandoffTransportCoordinatorError(
        "MANAGED_TRANSPORT_NOT_ACTIVE",
        "Managed Browser Handoff transport did not provide a locator"
      );
    }
    this.#generation = generation;
    this.#lastTransport = driver.kind;
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

function isPromiseLike(value: string | Promise<string>): value is Promise<string> {
  return typeof value === "object"
    && value !== null
    && typeof (value as Promise<string>).then === "function";
}
