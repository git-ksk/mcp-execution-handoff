import type { ElicitRequestFormParams } from "@modelcontextprotocol/server";
import { digestToolInvocation, type HandoffResumeStrategy } from "../core/index.js";
export const HANDOFF_INPUT_KEY = "human_intervention";
export const HANDOFF_STATE_TTL_SECONDS = 10 * 60;
export interface HandoffRequestState { version: 2; phase: "awaiting_human"; toolName: string; argsDigest: string; interventionId: string; epoch: number; resumeStrategy: HandoffResumeStrategy; principalBinding: string; }
export const HUMAN_INTERVENTION_SCHEMA: ElicitRequestFormParams["requestedSchema"] = { type: "object", properties: { decision: { type: "string", title: "Manual step", enum: ["continue", "cancel"], enumNames: ["Continue after completing it", "Cancel this operation"] } }, required: ["decision"] };
export function createHandoffRequestState(input: { toolName: string; args: unknown; interventionId: string; epoch: number; resumeStrategy: HandoffResumeStrategy; principalBinding: string; }): HandoffRequestState {
  return { version: 2, phase: "awaiting_human", toolName: input.toolName, argsDigest: digestToolInvocation(input.toolName, input.args), interventionId: input.interventionId, epoch: input.epoch, resumeStrategy: input.resumeStrategy, principalBinding: input.principalBinding };
}
export function handoffStateMatchesInvocation(state: HandoffRequestState, toolName: string, args: unknown, expectedPrincipalBinding: string): boolean {
  return state.version === 2 && state.phase === "awaiting_human" && state.toolName === toolName && state.argsDigest === digestToolInvocation(toolName, args) && state.principalBinding === expectedPrincipalBinding;
}
export function interventionPrompt(input: { subject: string; instruction?: string }): string {
  return [ `${input.subject} requires a manual step.`, input.instruction ?? "Complete that step directly in the controlled application.", "Do not paste passwords, OTP/MFA codes, CAPTCHA answers, cookies, payment data, or other credentials into the MCP prompt.", "Choose Continue only after the manual step is complete, or Cancel to stop the operation." ].join(" ");
}
