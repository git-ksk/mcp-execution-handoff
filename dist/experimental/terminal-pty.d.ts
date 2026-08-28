import { type ExecutionAuthority, type ExecutionIntervention, type InterventionStatus, type ResumeDecision } from "../core/lifecycle.js";
declare const TERMINAL_REASON: "terminal_pty";
export interface ExperimentalTerminalPtyBinding {
    sessionId: string;
    sessionGeneration: number;
    principalBinding: string;
}
export interface ExperimentalTerminalPtyFencePort {
    /** Wait only for Agent writes admitted before the Handoff FSM fenced Agent authority. */
    drainAgentWrites(): Promise<void>;
    /** Wait only for Human writes admitted before Done fenced Human authority. */
    drainHumanWrites(): Promise<void>;
}
export interface ExperimentalTerminalPtyStatus {
    authority: ExecutionAuthority;
    interventionStatus: InterventionStatus | null;
    interventionEpoch: number | null;
    sessionGeneration: number;
    sessionAlive: boolean;
    humanDisconnected: boolean;
    agentStateSynchronizationRequired: boolean;
}
export interface ExperimentalTerminalPtyResumeDecision extends ResumeDecision<never> {
    sessionAlive: boolean;
    agentStateSynchronizationRequired: boolean;
}
export declare class ExperimentalTerminalPtyError extends Error {
    readonly code: "TERMINAL_SESSION_BINDING_INVALID" | "TERMINAL_SESSION_MISMATCH" | "TERMINAL_SESSION_CLOSED" | "TERMINAL_INTERVENTION_STALE" | "TERMINAL_AGENT_STATE_SYNC_REQUIRED";
    constructor(code: "TERMINAL_SESSION_BINDING_INVALID" | "TERMINAL_SESSION_MISMATCH" | "TERMINAL_SESSION_CLOSED" | "TERMINAL_INTERVENTION_STALE" | "TERMINAL_AGENT_STATE_SYNC_REQUIRED", message: string);
}
/**
 * Experimental/internal authority gate for one consumer-owned PTY session.
 *
 * This type deliberately never receives terminal input/output bytes. The consumer owns PTY
 * mechanics, buffering, process/job-control observation, and content-free verification. Handoff
 * owns only exclusive authority, intervention/epoch fencing, drain boundaries, and explicit resume.
 * It is intentionally not exported from the package public entrypoints while #48 is dogfooded.
 */
export declare class ExperimentalTerminalPtyAuthority {
    private readonly fencePort;
    private readonly state;
    private readonly session;
    private sessionAlive;
    private humanDisconnected;
    private agentStateSynchronizationRequired;
    private humanWritesDrained;
    constructor(binding: ExperimentalTerminalPtyBinding, fencePort: ExperimentalTerminalPtyFencePort, now?: () => number, createId?: () => string);
    getStatus(): ExperimentalTerminalPtyStatus;
    /**
     * Fence new Agent input/observation immediately, then drain only Agent writes that were already
     * admitted before the fence. Human authority is not claimable until that boundary is complete.
     */
    beginFence(binding: ExperimentalTerminalPtyBinding): ExecutionIntervention<never, typeof TERMINAL_REASON>;
    claimHumanAfterAgentDrain(binding: ExperimentalTerminalPtyBinding, interventionId: string, epoch: number): ExecutionIntervention<never, typeof TERMINAL_REASON>;
    beginHuman(binding: ExperimentalTerminalPtyBinding): Promise<ExecutionIntervention<never, typeof TERMINAL_REASON>>;
    /**
     * Cancel only an intervention that never granted Human authority. This is the sole safe rollback
     * for transport/setup failure before claim; once Human authority existed, verification remains
     * mandatory and this path is unavailable.
     */
    cancelBeforeHuman(binding: ExperimentalTerminalPtyBinding, interventionId: string, epoch: number): ExperimentalTerminalPtyStatus;
    assertAgentInput(binding: ExperimentalTerminalPtyBinding): void;
    assertAgentObservation(binding: ExperimentalTerminalPtyBinding): void;
    assertAgentResize(binding: ExperimentalTerminalPtyBinding): void;
    assertHumanInput(binding: ExperimentalTerminalPtyBinding, interventionId: string, epoch: number): void;
    assertHumanObservation(binding: ExperimentalTerminalPtyBinding, interventionId: string, epoch: number): void;
    assertHumanResize(binding: ExperimentalTerminalPtyBinding, interventionId: string, epoch: number): void;
    /** Disconnect is transport-only: authority remains Human and Agent never resumes implicitly. */
    noteHumanDisconnect(binding: ExperimentalTerminalPtyBinding, interventionId: string, epoch: number): ExperimentalTerminalPtyStatus;
    /**
     * Done fences Human immediately by entering verifying, then drains only Human writes already
     * admitted before that fence. Consumer verification happens afterwards and never receives bytes
     * through this Handoff object.
     */
    markHumanDoneFence(binding: ExperimentalTerminalPtyBinding, interventionId: string, epoch: number): ExecutionIntervention<never, typeof TERMINAL_REASON>;
    confirmHumanWritesDrained(binding: ExperimentalTerminalPtyBinding, interventionId: string, epoch: number): ExecutionIntervention<never, typeof TERMINAL_REASON>;
    markHumanDone(binding: ExperimentalTerminalPtyBinding, interventionId: string, epoch: number): Promise<ExecutionIntervention<never, typeof TERMINAL_REASON>>;
    /**
     * Record only the consumer's content-free postcondition boolean. Terminal contents are never an
     * argument to the generic Handoff lifecycle.
     */
    reportVerification(binding: ExperimentalTerminalPtyBinding, interventionId: string, epoch: number, satisfied: boolean): ExecutionIntervention<never, typeof TERMINAL_REASON>;
    /** Explicit resume consumes Handoff state but never revives a closed PTY or clears state-sync. */
    resumeAgent(binding: ExperimentalTerminalPtyBinding, interventionId: string, epoch: number): ExperimentalTerminalPtyResumeDecision;
    /** Consumer calls this only after it has invalidated pre-handoff cwd/env/job/prompt assumptions. */
    acknowledgeAgentStateSynchronization(binding: ExperimentalTerminalPtyBinding): void;
    /**
     * PTY exit permanently closes this exact surface. If Human owned it, exit moves immediately to
     * verifying/none. No replacement PTY or usable Agent authority is synthesized.
     */
    noteSessionExit(binding: ExperimentalTerminalPtyBinding): ExperimentalTerminalPtyStatus;
    private effectiveAuthority;
    private requireSession;
    private requireIntervention;
}
export {};
//# sourceMappingURL=terminal-pty.d.ts.map