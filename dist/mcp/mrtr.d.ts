import type { ElicitRequestFormParams } from "@modelcontextprotocol/server";
import { type HandoffResumeStrategy } from "../core/index.js";
export declare const HANDOFF_INPUT_KEY = "human_intervention";
export declare const HANDOFF_STATE_TTL_SECONDS: number;
export interface HandoffRequestState {
    version: 2;
    phase: "awaiting_human";
    toolName: string;
    argsDigest: string;
    interventionId: string;
    epoch: number;
    resumeStrategy: HandoffResumeStrategy;
    principalBinding: string;
}
export declare const HUMAN_INTERVENTION_SCHEMA: ElicitRequestFormParams["requestedSchema"];
export declare function createHandoffRequestState(input: {
    toolName: string;
    args: unknown;
    interventionId: string;
    epoch: number;
    resumeStrategy: HandoffResumeStrategy;
    principalBinding: string;
}): HandoffRequestState;
export declare function handoffStateMatchesInvocation(state: HandoffRequestState, toolName: string, args: unknown, expectedPrincipalBinding: string): boolean;
export declare function interventionPrompt(input: {
    subject: string;
    instruction?: string;
}): string;
//# sourceMappingURL=mrtr.d.ts.map