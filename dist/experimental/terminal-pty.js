import { timingSafeEqual } from "node:crypto";
import { ExecutionHandoffState, } from "../core/lifecycle.js";
const TERMINAL_REASON = "terminal_pty";
export class ExperimentalTerminalPtyError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "ExperimentalTerminalPtyError";
    }
}
/**
 * Experimental/internal authority gate for one consumer-owned PTY session.
 *
 * This type deliberately never receives terminal input/output bytes. The consumer owns PTY
 * mechanics, buffering, process/job-control observation, and content-free verification. Handoff
 * owns only exclusive authority, intervention/epoch fencing, drain boundaries, and explicit resume.
 * It is intentionally not exported from the package public entrypoints while #48 is dogfooded.
 */
export class ExperimentalTerminalPtyAuthority {
    fencePort;
    state;
    session;
    sessionAlive = true;
    humanDisconnected = false;
    agentStateSynchronizationRequired = false;
    humanWritesDrained = true;
    constructor(binding, fencePort, now = Date.now, createId) {
        this.fencePort = fencePort;
        this.session = normalizeBinding(binding);
        this.state = createId
            ? new ExecutionHandoffState(now, createId)
            : new ExecutionHandoffState(now);
    }
    getStatus() {
        const active = this.state.getActive();
        return {
            authority: this.effectiveAuthority(),
            interventionStatus: active?.status ?? null,
            interventionEpoch: active?.epoch ?? null,
            sessionGeneration: this.session.sessionGeneration,
            sessionAlive: this.sessionAlive,
            humanDisconnected: this.humanDisconnected,
            agentStateSynchronizationRequired: this.agentStateSynchronizationRequired,
        };
    }
    /**
     * Fence new Agent input/observation immediately, then drain only Agent writes that were already
     * admitted before the fence. Human authority is not claimable until that boundary is complete.
     */
    beginFence(binding) {
        this.requireSession(binding, true);
        const intervention = this.state.begin({ reason: TERMINAL_REASON, resumePolicy: "never_replay" });
        this.humanWritesDrained = true;
        return intervention;
    }
    claimHumanAfterAgentDrain(binding, interventionId, epoch) {
        this.requireSession(binding, true);
        this.requireIntervention(interventionId, epoch, "awaiting_human");
        this.humanDisconnected = false;
        return this.state.claimHuman(interventionId);
    }
    async beginHuman(binding) {
        const intervention = this.beginFence(binding);
        await this.fencePort.drainAgentWrites();
        return this.claimHumanAfterAgentDrain(binding, intervention.id, intervention.epoch);
    }
    /**
     * Cancel only an intervention that never granted Human authority. This is the sole safe rollback
     * for transport/setup failure before claim; once Human authority existed, verification remains
     * mandatory and this path is unavailable.
     */
    cancelBeforeHuman(binding, interventionId, epoch) {
        this.requireSession(binding, true);
        const active = this.requireIntervention(interventionId, epoch, "awaiting_human");
        this.state.cancel(active.id);
        this.humanDisconnected = false;
        this.humanWritesDrained = true;
        return this.getStatus();
    }
    assertAgentInput(binding) {
        this.requireSession(binding, true);
        this.state.assertAgentAuthority();
        if (this.agentStateSynchronizationRequired) {
            throw new ExperimentalTerminalPtyError("TERMINAL_AGENT_STATE_SYNC_REQUIRED", "Agent terminal input requires fresh consumer-side state synchronization after Human handoff");
        }
    }
    assertAgentObservation(binding) {
        this.requireSession(binding, true);
        this.state.assertAgentAuthority();
        if (this.agentStateSynchronizationRequired) {
            throw new ExperimentalTerminalPtyError("TERMINAL_AGENT_STATE_SYNC_REQUIRED", "Agent terminal observation requires fresh consumer-side state synchronization after Human handoff");
        }
    }
    assertAgentResize(binding) {
        this.assertAgentInput(binding);
    }
    assertHumanInput(binding, interventionId, epoch) {
        this.requireSession(binding, true);
        this.requireIntervention(interventionId, epoch, "human_active");
    }
    assertHumanObservation(binding, interventionId, epoch) {
        this.assertHumanInput(binding, interventionId, epoch);
    }
    assertHumanResize(binding, interventionId, epoch) {
        this.assertHumanInput(binding, interventionId, epoch);
    }
    /** Disconnect is transport-only: authority remains Human and Agent never resumes implicitly. */
    noteHumanDisconnect(binding, interventionId, epoch) {
        this.assertHumanInput(binding, interventionId, epoch);
        this.humanDisconnected = true;
        return this.getStatus();
    }
    /**
     * Done fences Human immediately by entering verifying, then drains only Human writes already
     * admitted before that fence. Consumer verification happens afterwards and never receives bytes
     * through this Handoff object.
     */
    markHumanDoneFence(binding, interventionId, epoch) {
        this.requireSession(binding, false);
        this.requireIntervention(interventionId, epoch, "human_active");
        const verifying = this.state.markHumanComplete(interventionId);
        this.humanDisconnected = false;
        this.agentStateSynchronizationRequired = true;
        this.humanWritesDrained = false;
        return verifying;
    }
    confirmHumanWritesDrained(binding, interventionId, epoch) {
        this.requireSession(binding, false);
        const verifying = this.requireIntervention(interventionId, epoch, "verifying");
        this.humanWritesDrained = true;
        return verifying;
    }
    async markHumanDone(binding, interventionId, epoch) {
        const verifying = this.markHumanDoneFence(binding, interventionId, epoch);
        await this.fencePort.drainHumanWrites();
        return this.confirmHumanWritesDrained(binding, verifying.id, verifying.epoch);
    }
    /**
     * Record only the consumer's content-free postcondition boolean. Terminal contents are never an
     * argument to the generic Handoff lifecycle.
     */
    reportVerification(binding, interventionId, epoch, satisfied) {
        this.requireSession(binding, false);
        this.requireIntervention(interventionId, epoch, "verifying");
        if (!this.humanWritesDrained) {
            throw new ExperimentalTerminalPtyError("TERMINAL_INTERVENTION_STALE", "Terminal verification is fenced until admitted Human writes are drained");
        }
        if (!satisfied)
            return this.state.getActive();
        return this.state.markVerified(interventionId);
    }
    /** Explicit resume consumes Handoff state but never revives a closed PTY or clears state-sync. */
    resumeAgent(binding, interventionId, epoch) {
        this.requireSession(binding, false);
        this.requireIntervention(interventionId, epoch, "ready_to_resume");
        const decision = this.state.resumeAgent(interventionId);
        return {
            ...decision,
            sessionAlive: this.sessionAlive,
            agentStateSynchronizationRequired: this.agentStateSynchronizationRequired,
        };
    }
    /** Consumer calls this only after it has invalidated pre-handoff cwd/env/job/prompt assumptions. */
    acknowledgeAgentStateSynchronization(binding) {
        this.requireSession(binding, true);
        if (this.state.getAuthority() !== "agent") {
            throw new ExperimentalTerminalPtyError("TERMINAL_INTERVENTION_STALE", "Agent terminal state synchronization is allowed only after explicit resume");
        }
        this.agentStateSynchronizationRequired = false;
    }
    /**
     * PTY exit permanently closes this exact surface. If Human owned it, exit moves immediately to
     * verifying/none. No replacement PTY or usable Agent authority is synthesized.
     */
    noteSessionExit(binding) {
        this.requireSession(binding, false);
        if (!this.sessionAlive)
            return this.getStatus();
        this.sessionAlive = false;
        this.agentStateSynchronizationRequired = true;
        const active = this.state.getActive();
        if (active?.status === "awaiting_human") {
            // No Human authority was ever granted, so there can be no Human side effect to verify.
            // Cancel only this pre-claim intervention and advance the epoch; the closed PTY still keeps
            // effective authority at none and can never be revived by this transition.
            this.state.cancel(active.id);
            this.humanWritesDrained = true;
        }
        else if (active?.status === "human_active") {
            this.state.markHumanComplete(active.id);
            this.humanWritesDrained = true;
        }
        this.humanDisconnected = false;
        return this.getStatus();
    }
    effectiveAuthority() {
        if (!this.sessionAlive && this.state.getAuthority() === "agent")
            return "none";
        return this.state.getAuthority();
    }
    requireSession(binding, requireAlive) {
        const normalized = normalizeBinding(binding);
        if (!sameString(normalized.sessionId, this.session.sessionId)
            || normalized.sessionGeneration !== this.session.sessionGeneration
            || !sameString(normalized.principalBinding, this.session.principalBinding)) {
            throw new ExperimentalTerminalPtyError("TERMINAL_SESSION_MISMATCH", "Terminal PTY binding no longer matches the exact session");
        }
        if (requireAlive && !this.sessionAlive) {
            throw new ExperimentalTerminalPtyError("TERMINAL_SESSION_CLOSED", "Terminal PTY session is closed");
        }
    }
    requireIntervention(interventionId, epoch, expected) {
        const active = this.state.getActive();
        if (!active
            || !sameString(active.id, interventionId)
            || active.epoch !== epoch
            || active.status !== expected) {
            throw new ExperimentalTerminalPtyError("TERMINAL_INTERVENTION_STALE", "Terminal intervention, epoch, or lifecycle state is stale");
        }
        return active;
    }
}
function normalizeBinding(binding) {
    const sessionId = binding.sessionId.trim();
    const principalBinding = binding.principalBinding.trim();
    if (!sessionId
        || sessionId.length > 200
        || !/^[A-Za-z0-9._:-]+$/.test(sessionId)
        || !Number.isSafeInteger(binding.sessionGeneration)
        || binding.sessionGeneration <= 0
        || !principalBinding
        || principalBinding.length > 512
        || /[\r\n]/.test(principalBinding)) {
        throw new ExperimentalTerminalPtyError("TERMINAL_SESSION_BINDING_INVALID", "Terminal PTY session binding is invalid");
    }
    return { sessionId, sessionGeneration: binding.sessionGeneration, principalBinding };
}
function sameString(left, right) {
    const expected = Buffer.from(left, "utf8");
    const supplied = Buffer.from(right, "utf8");
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
//# sourceMappingURL=terminal-pty.js.map