import { digestToolInvocation } from "../core/index.js";
export const HANDOFF_INPUT_KEY = "human_intervention";
export const HANDOFF_STATE_TTL_SECONDS = 10 * 60;
export const HUMAN_INTERVENTION_SCHEMA = { type: "object", properties: { decision: { type: "string", title: "Manual step", enum: ["continue", "cancel"], enumNames: ["Continue after completing it", "Cancel this operation"] } }, required: ["decision"] };
export function createHandoffRequestState(input) {
    return { version: 2, phase: "awaiting_human", toolName: input.toolName, argsDigest: digestToolInvocation(input.toolName, input.args), interventionId: input.interventionId, epoch: input.epoch, resumeStrategy: input.resumeStrategy, principalBinding: input.principalBinding };
}
export function handoffStateMatchesInvocation(state, toolName, args, expectedPrincipalBinding) {
    return state.version === 2 && state.phase === "awaiting_human" && state.toolName === toolName && state.argsDigest === digestToolInvocation(toolName, args) && state.principalBinding === expectedPrincipalBinding;
}
export function interventionPrompt(input) {
    return [`${input.subject} requires a manual step.`, input.instruction ?? "Complete that step directly in the controlled application.", "Do not paste passwords, OTP/MFA codes, CAPTCHA answers, cookies, payment data, or other credentials into the MCP prompt.", "Choose Continue only after the manual step is complete, or Cancel to stop the operation."].join(" ");
}
//# sourceMappingURL=mrtr.js.map