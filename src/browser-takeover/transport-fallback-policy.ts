export type BrowserHandoffTransportAttempt =
  | "webrtc_direct"
  | "websocket_relay"
  | "webrtc_relay";

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
export function browserHandoffTransportAttemptOrder(
  policy: BrowserHandoffTransportFallbackPolicy
): readonly BrowserHandoffTransportAttempt[] {
  const order: BrowserHandoffTransportAttempt[] = ["webrtc_direct"];
  if (policy.websocketRelayEnabled) order.push("websocket_relay");
  if (policy.webrtcRelayEnabled) order.push("webrtc_relay");
  return order;
}

/** Returns the next staged transport only when the completed attempt belongs to the plan. */
export function nextBrowserHandoffTransportAttempt(
  order: readonly BrowserHandoffTransportAttempt[],
  completedAttempt: BrowserHandoffTransportAttempt
): BrowserHandoffTransportAttempt | undefined {
  const index = order.indexOf(completedAttempt);
  if (index < 0) return undefined;
  return order[index + 1];
}
