export type BrowserHandoffTransportAttempt =
  | "webrtc_direct"
  | "websocket_relay"
  | "webrtc_relay";

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

export class ManagedHandoffTransportPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedHandoffTransportPolicyError";
  }
}

const TRANSPORT_ATTEMPTS = new Set<BrowserHandoffTransportAttempt>([
  "webrtc_direct",
  "websocket_relay",
  "webrtc_relay"
]);

/**
 * Validate and freeze an explicit Handoff-owned Browser/Window transport plan.
 *
 * The plan is deliberately finite and closed-world: at least one supported attempt, no duplicates,
 * and no implicit attempt insertion. This makes WSS-only, direct-only, relay-capable-WebRTC-only,
 * and arbitrary reviewed fallback orders expressible without silently widening authority.
 */
export function browserHandoffTransportAttemptOrder(
  policy: ManagedHandoffTransportPolicy
): readonly BrowserHandoffTransportAttempt[] {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new ManagedHandoffTransportPolicyError("Managed Handoff transport policy is invalid");
  }
  const record = policy as unknown as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Array.isArray(record.order)) {
    throw new ManagedHandoffTransportPolicyError("Managed Handoff transport policy must contain only order");
  }
  if (record.order.length < 1 || record.order.length > TRANSPORT_ATTEMPTS.size) {
    throw new ManagedHandoffTransportPolicyError("Managed Handoff transport order must contain one to three attempts");
  }
  const order: BrowserHandoffTransportAttempt[] = [];
  const seen = new Set<BrowserHandoffTransportAttempt>();
  for (const value of record.order) {
    if (typeof value !== "string" || !TRANSPORT_ATTEMPTS.has(value as BrowserHandoffTransportAttempt)) {
      throw new ManagedHandoffTransportPolicyError("Managed Handoff transport order contains an unsupported attempt");
    }
    const attempt = value as BrowserHandoffTransportAttempt;
    if (seen.has(attempt)) {
      throw new ManagedHandoffTransportPolicyError("Managed Handoff transport order cannot contain duplicates");
    }
    seen.add(attempt);
    order.push(attempt);
  }
  return Object.freeze(order);
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

/** Compatibility alias for the existing Browser-shaped internal coordinator naming. */
export type BrowserHandoffTransportPolicy = ManagedHandoffTransportPolicy;
