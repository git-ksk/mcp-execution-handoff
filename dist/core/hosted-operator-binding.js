export class HostedOperatorBindingError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "HostedOperatorBindingError";
    }
}
const SESSION_KEYS = new Set([
    "sessionId",
    "interventionId",
    "epoch",
    "principalBinding",
    "expiresAt",
    "viewerGeneration"
]);
function boundedString(value, min, max) {
    return typeof value === "string"
        && value.length >= min
        && value.length <= max
        && !/[\0\r\n]/.test(value);
}
export function parseHostedOperatorSessionReference(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new HostedOperatorBindingError("HOSTED_OPERATOR_SESSION_INVALID", "Invalid hosted operator session reference");
    }
    const record = value;
    if (Object.keys(record).some((key) => !SESSION_KEYS.has(key))
        || !boundedString(record.sessionId, 1, 160)
        || !boundedString(record.interventionId, 1, 160)
        || !Number.isSafeInteger(record.epoch) || Number(record.epoch) < 0
        || !boundedString(record.principalBinding, 16, 160)
        || !Number.isSafeInteger(record.expiresAt) || Number(record.expiresAt) < 0
        || !Number.isSafeInteger(record.viewerGeneration) || Number(record.viewerGeneration) <= 0) {
        throw new HostedOperatorBindingError("HOSTED_OPERATOR_SESSION_INVALID", "Invalid hosted operator session reference");
    }
    return {
        sessionId: record.sessionId,
        interventionId: record.interventionId,
        epoch: record.epoch,
        principalBinding: record.principalBinding,
        expiresAt: record.expiresAt,
        viewerGeneration: record.viewerGeneration
    };
}
function sameSessionIdentity(expected, current) {
    return expected.sessionId === current.sessionId
        && expected.interventionId === current.interventionId
        && expected.epoch === current.epoch
        && expected.principalBinding === current.principalBinding;
}
function assertSessionLive(session, now) {
    if (!Number.isSafeInteger(now) || now < 0) {
        throw new HostedOperatorBindingError("HOSTED_OPERATOR_SESSION_INVALID", "Invalid hosted operator session time");
    }
    if (session.expiresAt <= now) {
        throw new HostedOperatorBindingError("HOSTED_OPERATOR_SESSION_EXPIRED", "Hosted operator session expired");
    }
}
/**
 * Compose an existing operator session with one current worker route without creating another FSM.
 *
 * The two lifetimes stay independent:
 * - operator TTL / viewer generation come from the surface session manager;
 * - worker connection / worker generation come from HostedWorkerRegistry.
 */
export function bindHostedOperatorSession(operatorValue, worker, registry, now = Date.now()) {
    const operator = parseHostedOperatorSessionReference(operatorValue);
    assertSessionLive(operator, now);
    registry.assertCurrent(worker);
    if (operator.interventionId !== worker.interventionId
        || operator.epoch !== worker.epoch
        || operator.principalBinding !== worker.principalBinding) {
        throw new HostedOperatorBindingError("HOSTED_OPERATOR_SESSION_MISMATCH", "Hosted operator session does not match the worker route");
    }
    return {
        operator: { ...operator },
        worker: { ...worker }
    };
}
/**
 * Revalidate a process-local hosted binding against both authoritative current states.
 *
 * Worker reconnect may rotate only the worker generation while leaving the operator TTL and viewer
 * generation unchanged. Viewer reconnect may rotate only the viewer generation. Neither rotation
 * is accepted by an old binding; the caller must explicitly create a fresh composed binding.
 */
export function assertHostedOperatorBindingCurrent(binding, currentOperatorValue, registry, now = Date.now()) {
    const bound = parseHostedOperatorSessionReference(binding.operator);
    const current = parseHostedOperatorSessionReference(currentOperatorValue);
    assertSessionLive(current, now);
    if (!sameSessionIdentity(bound, current) || bound.expiresAt !== current.expiresAt) {
        throw new HostedOperatorBindingError("HOSTED_OPERATOR_SESSION_MISMATCH", "Hosted operator session identity changed");
    }
    if (bound.viewerGeneration !== current.viewerGeneration) {
        throw new HostedOperatorBindingError("HOSTED_OPERATOR_VIEWER_STALE", "Hosted operator viewer generation is stale");
    }
    registry.assertCurrent(binding.worker);
    if (binding.worker.interventionId !== current.interventionId
        || binding.worker.epoch !== current.epoch
        || binding.worker.principalBinding !== current.principalBinding) {
        throw new HostedOperatorBindingError("HOSTED_OPERATOR_SESSION_MISMATCH", "Hosted operator session no longer matches the worker route");
    }
}
//# sourceMappingURL=hosted-operator-binding.js.map