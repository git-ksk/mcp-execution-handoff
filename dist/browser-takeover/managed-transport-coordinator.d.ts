import { type BrowserHandoffTransportAttempt, type BrowserHandoffTransportFallbackPolicy } from "./transport-fallback-policy.js";
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
    readonly generation: number;
    readonly transitionCount: number;
    readonly lastFallbackReason?: ManagedBrowserHandoffFallbackReason;
}
export declare class ManagedBrowserHandoffTransportCoordinatorError extends Error {
    readonly code: "MANAGED_TRANSPORT_PLAN_INVALID" | "MANAGED_TRANSPORT_ALREADY_STARTED" | "MANAGED_TRANSPORT_NOT_ACTIVE" | "MANAGED_TRANSPORT_STALE";
    constructor(code: "MANAGED_TRANSPORT_PLAN_INVALID" | "MANAGED_TRANSPORT_ALREADY_STARTED" | "MANAGED_TRANSPORT_NOT_ACTIVE" | "MANAGED_TRANSPORT_STALE", message: string);
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
export declare class ManagedBrowserHandoffTransportCoordinator {
    #private;
    constructor(policy: BrowserHandoffTransportFallbackPolicy, drivers: readonly ManagedBrowserHandoffTransportDriver[]);
    start(): Promise<ManagedBrowserHandoffTransportLease>;
    /**
     * Synchronous first-attempt entry used by the existing synchronous Browser/Window `start()` API.
     * Managed facade drivers are required to mint locators synchronously; network readiness remains a
     * later bounded transport concern. Async drivers must use `start()` instead and fail closed here.
     */
    startSync(): ManagedBrowserHandoffTransportLease;
    advance(lease: Pick<ManagedBrowserHandoffTransportLease, "transport" | "generation">): Promise<ManagedBrowserHandoffTransportLease | undefined>;
    /**
     * Advance after a bounded transport failure. Failed later transports are fully revoked before the
     * next staged attempt is considered, so WSS unavailability may reach optional TURN without ever
     * leaving two mutable Human transports active at once.
     */
    fallback(lease: Pick<ManagedBrowserHandoffTransportLease, "transport" | "generation">, reason: ManagedBrowserHandoffFallbackReason): Promise<ManagedBrowserHandoffTransportLease | undefined>;
    revoke(lease?: Pick<ManagedBrowserHandoffTransportLease, "transport" | "generation">): Promise<void>;
    snapshot(): ManagedBrowserHandoffTransportLease | undefined;
    diagnosticsSnapshot(): ManagedBrowserHandoffTransportSnapshot;
}
//# sourceMappingURL=managed-transport-coordinator.d.ts.map