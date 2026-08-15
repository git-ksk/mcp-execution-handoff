import { randomUUID } from "node:crypto";
export const RESUME_POLICIES = ["replay_safe", "revalidate", "confirm_before_execute", "never_replay"];
export class ExecutionHandoffError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "ExecutionHandoffError";
    }
}
export class ExecutionHandoffState {
    now;
    createId;
    epoch = 0;
    active;
    constructor(now = Date.now, createId = randomUUID) {
        this.now = now;
        this.createId = createId;
    }
    getResourceEpoch() { return this.epoch; }
    getAuthority() {
        if (!this.active)
            return "agent";
        return this.active.status === "human_active" ? "human" : "none";
    }
    getActive() { return this.active ? { ...this.active } : undefined; }
    advanceResourceEpoch() { this.epoch += 1; return this.epoch; }
    begin(input) {
        if (this.active)
            return { ...this.active };
        const now = this.now();
        const intervention = {
            id: this.createId(), reason: input.reason, status: "awaiting_human", authority: "none",
            epoch: this.advanceResourceEpoch(), resumePolicy: input.resumePolicy, createdAt: now, updatedAt: now
        };
        if (input.action !== undefined)
            intervention.action = input.action;
        this.active = intervention;
        return { ...intervention };
    }
    claimHuman(interventionId) {
        const active = this.requireActive(interventionId);
        if (active.status === "human_active")
            return { ...active };
        if (active.status !== "awaiting_human" && active.status !== "verifying") {
            throw new ExecutionHandoffError("INTERVENTION_STATE_CHANGED", `Intervention ${active.id} is ${active.status}; expected awaiting_human or verifying`);
        }
        active.status = "human_active";
        active.authority = "human";
        active.updatedAt = this.now();
        return { ...active };
    }
    markHumanComplete(interventionId) {
        const active = this.requireActive(interventionId);
        this.requireStatus(active, "human_active");
        active.status = "verifying";
        active.authority = "none";
        active.epoch = this.advanceResourceEpoch();
        active.updatedAt = this.now();
        return { ...active };
    }
    returnToHuman(interventionId) {
        const active = this.requireActive(interventionId);
        this.requireStatus(active, "verifying");
        active.status = "human_active";
        active.authority = "human";
        active.updatedAt = this.now();
        return { ...active };
    }
    markVerified(interventionId) {
        const active = this.requireActive(interventionId);
        this.requireStatus(active, "verifying");
        active.status = "ready_to_resume";
        active.updatedAt = this.now();
        return { ...active };
    }
    resumeAgent(interventionId) {
        const active = this.requireActive(interventionId);
        this.requireStatus(active, "ready_to_resume");
        const decision = { resumePolicy: active.resumePolicy, epoch: active.epoch };
        if (active.action !== undefined)
            decision.action = active.action;
        this.active = undefined;
        return decision;
    }
    cancel(interventionId) { this.requireActive(interventionId); this.active = undefined; this.advanceResourceEpoch(); }
    assertAgentAuthority() {
        if (!this.active)
            return;
        throw new ExecutionHandoffError("AGENT_AUTHORITY_SUSPENDED", `Agent authority is suspended while intervention ${this.active.id} is ${this.active.status}`);
    }
    requireActive(interventionId) {
        if (!this.active || this.active.id !== interventionId)
            throw new ExecutionHandoffError("INTERVENTION_NOT_FOUND", "The intervention is no longer active");
        return this.active;
    }
    requireStatus(active, expected) {
        if (active.status !== expected)
            throw new ExecutionHandoffError("INTERVENTION_STATE_CHANGED", `Intervention ${active.id} is ${active.status}; expected ${expected}`);
    }
}
//# sourceMappingURL=lifecycle.js.map