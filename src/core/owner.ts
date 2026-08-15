import { digestToolInvocation } from "./invocation.js";
export type HandoffResumeStrategy = "retry_original" | "require_fresh_semantic_action";
export interface HandoffOwner { principalBinding: string; toolName: string; argsDigest: string; resumeStrategy: HandoffResumeStrategy; }
export function createHandoffOwner(principalBinding: string, toolName: string, args: unknown, resumeStrategy: HandoffResumeStrategy): HandoffOwner {
  return { principalBinding, toolName, argsDigest: digestToolInvocation(toolName, args), resumeStrategy };
}
export function handoffOwnerMatches(left: HandoffOwner, right: HandoffOwner): boolean {
  return left.principalBinding === right.principalBinding && left.toolName === right.toolName && left.argsDigest === right.argsDigest && left.resumeStrategy === right.resumeStrategy;
}
export function claimHandoffOwner(owners: Map<string, HandoffOwner>, interventionId: string, interventionStatus: string, candidate: HandoffOwner): HandoffOwner | undefined {
  const existing = owners.get(interventionId);
  if (existing) return handoffOwnerMatches(existing, candidate) ? existing : undefined;
  if (interventionStatus !== "awaiting_human") return undefined;
  owners.set(interventionId, candidate); return candidate;
}
