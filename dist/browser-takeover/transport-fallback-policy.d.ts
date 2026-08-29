export type BrowserHandoffTransportAttempt = "webrtc_direct" | "websocket_relay" | "webrtc_relay";
export interface ManagedHandoffTransportPolicy {
    /**
     * Exact staged attempt order. A one-item order is an explicit transport-only mode.
     *
     * `webrtc_relay` means the existing relay-capable WebRTC runtime: TURN may be selected when ICE
     * needs it, but relay-only ICE is not implied. Provider choice and credentials remain Handoff
     * deployment concerns rather than consumer semantic input.
     */
    order: readonly BrowserHandoffTransportAttempt[];
}
export declare class ManagedHandoffTransportPolicyError extends Error {
    constructor(message: string);
}
/**
 * Validate and freeze an explicit Handoff-owned Browser/Window transport plan.
 *
 * The plan is deliberately finite and closed-world: at least one supported attempt, no duplicates,
 * and no implicit attempt insertion. This makes WSS-only, direct-only, relay-capable-WebRTC-only,
 * and arbitrary reviewed fallback orders expressible without silently widening authority.
 */
export declare function browserHandoffTransportAttemptOrder(policy: ManagedHandoffTransportPolicy): readonly BrowserHandoffTransportAttempt[];
/** Returns the next staged transport only when the completed attempt belongs to the plan. */
export declare function nextBrowserHandoffTransportAttempt(order: readonly BrowserHandoffTransportAttempt[], completedAttempt: BrowserHandoffTransportAttempt): BrowserHandoffTransportAttempt | undefined;
/** Compatibility alias for the existing Browser-shaped internal coordinator naming. */
export type BrowserHandoffTransportPolicy = ManagedHandoffTransportPolicy;
//# sourceMappingURL=transport-fallback-policy.d.ts.map