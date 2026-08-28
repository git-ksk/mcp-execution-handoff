export type BrowserHandoffTransportAttempt = "webrtc_direct" | "websocket_relay" | "webrtc_relay";
export interface BrowserHandoffTransportFallbackPolicy {
    websocketRelayEnabled: boolean;
    webrtcRelayEnabled: boolean;
}
/**
 * Returns the Handoff-owned Browser/Window transport attempt order.
 *
 * This helper is intentionally internal: consumers choose a Human Handoff policy, not ICE/TURN
 * or WebSocket providers. A caller must fully revoke/fence one attempt before advancing to the
 * next returned transport; this function only defines the deterministic connectivity order.
 */
export declare function browserHandoffTransportAttemptOrder(policy: BrowserHandoffTransportFallbackPolicy): readonly BrowserHandoffTransportAttempt[];
/** Returns the next staged transport only when the completed attempt belongs to the plan. */
export declare function nextBrowserHandoffTransportAttempt(order: readonly BrowserHandoffTransportAttempt[], completedAttempt: BrowserHandoffTransportAttempt): BrowserHandoffTransportAttempt | undefined;
//# sourceMappingURL=transport-fallback-policy.d.ts.map