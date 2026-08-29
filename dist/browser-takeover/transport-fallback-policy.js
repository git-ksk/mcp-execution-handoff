export class ManagedHandoffTransportPolicyError extends Error {
    constructor(message) {
        super(message);
        this.name = "ManagedHandoffTransportPolicyError";
    }
}
const TRANSPORT_ATTEMPTS = new Set([
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
export function browserHandoffTransportAttemptOrder(policy) {
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
        throw new ManagedHandoffTransportPolicyError("Managed Handoff transport policy is invalid");
    }
    const record = policy;
    if (Object.keys(record).length !== 1 || !Array.isArray(record.order)) {
        throw new ManagedHandoffTransportPolicyError("Managed Handoff transport policy must contain only order");
    }
    if (record.order.length < 1 || record.order.length > TRANSPORT_ATTEMPTS.size) {
        throw new ManagedHandoffTransportPolicyError("Managed Handoff transport order must contain one to three attempts");
    }
    const order = [];
    const seen = new Set();
    for (const value of record.order) {
        if (typeof value !== "string" || !TRANSPORT_ATTEMPTS.has(value)) {
            throw new ManagedHandoffTransportPolicyError("Managed Handoff transport order contains an unsupported attempt");
        }
        const attempt = value;
        if (seen.has(attempt)) {
            throw new ManagedHandoffTransportPolicyError("Managed Handoff transport order cannot contain duplicates");
        }
        seen.add(attempt);
        order.push(attempt);
    }
    return Object.freeze(order);
}
/** Returns the next staged transport only when the completed attempt belongs to the plan. */
export function nextBrowserHandoffTransportAttempt(order, completedAttempt) {
    const index = order.indexOf(completedAttempt);
    if (index < 0)
        return undefined;
    return order[index + 1];
}
//# sourceMappingURL=transport-fallback-policy.js.map