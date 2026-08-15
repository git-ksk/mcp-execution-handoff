export declare const RESUME_POLICIES: readonly ["replay_safe", "revalidate", "confirm_before_execute", "never_replay"];
export type ResumePolicy = (typeof RESUME_POLICIES)[number];
export type ExecutionAuthority = "agent" | "human" | "none";
export type InterventionStatus = "awaiting_human" | "human_active" | "verifying" | "ready_to_resume";
export interface ExecutionIntervention<TAction, TReason extends string = string> {
    id: string;
    reason: TReason;
    status: InterventionStatus;
    authority: Exclude<ExecutionAuthority, "agent">;
    epoch: number;
    action?: TAction;
    resumePolicy: ResumePolicy;
    createdAt: number;
    updatedAt: number;
}
export interface ResumeDecision<TAction> {
    action?: TAction;
    resumePolicy: ResumePolicy;
    epoch: number;
}
export declare class ExecutionHandoffError extends Error {
    readonly code: "INTERVENTION_NOT_FOUND" | "INTERVENTION_STATE_CHANGED" | "AGENT_AUTHORITY_SUSPENDED";
    constructor(code: "INTERVENTION_NOT_FOUND" | "INTERVENTION_STATE_CHANGED" | "AGENT_AUTHORITY_SUSPENDED", message: string);
}
export declare class ExecutionHandoffState<TAction, TReason extends string = string> {
    private readonly now;
    private readonly createId;
    private epoch;
    private active;
    constructor(now?: () => number, createId?: () => string);
    getResourceEpoch(): number;
    getAuthority(): ExecutionAuthority;
    getActive(): ExecutionIntervention<TAction, TReason> | undefined;
    advanceResourceEpoch(): number;
    begin(input: {
        reason: TReason;
        action?: TAction;
        resumePolicy: ResumePolicy;
    }): ExecutionIntervention<TAction, TReason>;
    claimHuman(interventionId: string): ExecutionIntervention<TAction, TReason>;
    markHumanComplete(interventionId: string): ExecutionIntervention<TAction, TReason>;
    returnToHuman(interventionId: string): ExecutionIntervention<TAction, TReason>;
    markVerified(interventionId: string): ExecutionIntervention<TAction, TReason>;
    resumeAgent(interventionId: string): ResumeDecision<TAction>;
    cancel(interventionId: string): void;
    assertAgentAuthority(): void;
    private requireActive;
    private requireStatus;
}
//# sourceMappingURL=lifecycle.d.ts.map