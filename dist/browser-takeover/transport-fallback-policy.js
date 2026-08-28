/**
 * Returns the Handoff-owned Browser/Window transport attempt order.
 *
 * This helper is intentionally internal: consumers choose a Human Handoff policy, not ICE/TURN
 * or WebSocket providers. A caller must fully revoke/fence one attempt before advancing to the
 * next returned transport; this function only defines the deterministic connectivity order.
 */
export function browserHandoffTransportAttemptOrder(policy) {
    const order = ["webrtc_direct"];
    if (policy.websocketRelayEnabled)
        order.push("websocket_relay");
    if (policy.webrtcRelayEnabled)
        order.push("webrtc_relay");
    return order;
}
/** Returns the next staged transport only when the completed attempt belongs to the plan. */
export function nextBrowserHandoffTransportAttempt(order, completedAttempt) {
    const index = order.indexOf(completedAttempt);
    if (index < 0)
        return undefined;
    return order[index + 1];
}
//# sourceMappingURL=transport-fallback-policy.js.map