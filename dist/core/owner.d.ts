export type HandoffResumeStrategy = "retry_original" | "require_fresh_semantic_action";
export interface HandoffOwner {
    principalBinding: string;
    toolName: string;
    argsDigest: string;
    resumeStrategy: HandoffResumeStrategy;
}
export declare function createHandoffOwner(principalBinding: string, toolName: string, args: unknown, resumeStrategy: HandoffResumeStrategy): HandoffOwner;
export declare function handoffOwnerMatches(left: HandoffOwner, right: HandoffOwner): boolean;
export declare function claimHandoffOwner(owners: Map<string, HandoffOwner>, interventionId: string, interventionStatus: string, candidate: HandoffOwner): HandoffOwner | undefined;
//# sourceMappingURL=owner.d.ts.map