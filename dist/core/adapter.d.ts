export interface ExecutionHandoffAdapter<TIntervention, TResumeDecision> {
    getResourceEpoch(): number;
    getActiveIntervention(): TIntervention | undefined;
    claimHumanControl(interventionId: string): TIntervention;
    markHumanControlComplete(interventionId: string): TIntervention;
    verifyHumanIntervention(interventionId: string): Promise<TIntervention>;
    resumeAfterHumanIntervention(interventionId: string): TResumeDecision;
    cancelHumanIntervention(interventionId: string): void;
}
export interface RegisteredExecutionAdapter<TIntervention, TResumeDecision> {
    kind: string;
    control: ExecutionHandoffAdapter<TIntervention, TResumeDecision>;
}
export declare function defineExecutionAdapter<TIntervention, TResumeDecision>(kind: string, control: ExecutionHandoffAdapter<TIntervention, TResumeDecision>): RegisteredExecutionAdapter<TIntervention, TResumeDecision>;
//# sourceMappingURL=adapter.d.ts.map