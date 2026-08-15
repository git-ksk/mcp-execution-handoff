export interface ExecutionHandoffAdapter<TIntervention, TResumeDecision> {
  getResourceEpoch(): number;
  getActiveIntervention(): TIntervention | undefined;
  claimHumanControl(interventionId: string): TIntervention;
  markHumanControlComplete(interventionId: string): TIntervention;
  verifyHumanIntervention(interventionId: string): Promise<TIntervention>;
  resumeAfterHumanIntervention(interventionId: string): TResumeDecision;
  cancelHumanIntervention(interventionId: string): void;
}
export interface RegisteredExecutionAdapter<TIntervention, TResumeDecision> { kind: string; control: ExecutionHandoffAdapter<TIntervention, TResumeDecision>; }
export function defineExecutionAdapter<TIntervention, TResumeDecision>(kind: string, control: ExecutionHandoffAdapter<TIntervention, TResumeDecision>): RegisteredExecutionAdapter<TIntervention, TResumeDecision> {
  const normalized = kind.trim();
  if (!normalized || normalized.length > 80) throw new Error("execution adapter kind must contain 1-80 characters");
  return { kind: normalized, control };
}
