import { digestToolInvocation } from "./invocation.js";
export function createHandoffOwner(principalBinding, toolName, args, resumeStrategy) {
    return { principalBinding, toolName, argsDigest: digestToolInvocation(toolName, args), resumeStrategy };
}
export function handoffOwnerMatches(left, right) {
    return left.principalBinding === right.principalBinding && left.toolName === right.toolName && left.argsDigest === right.argsDigest && left.resumeStrategy === right.resumeStrategy;
}
export function claimHandoffOwner(owners, interventionId, interventionStatus, candidate) {
    const existing = owners.get(interventionId);
    if (existing)
        return handoffOwnerMatches(existing, candidate) ? existing : undefined;
    if (interventionStatus !== "awaiting_human")
        return undefined;
    owners.set(interventionId, candidate);
    return candidate;
}
//# sourceMappingURL=owner.js.map