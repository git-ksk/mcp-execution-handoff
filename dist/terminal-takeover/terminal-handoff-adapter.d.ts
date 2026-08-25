import type { ExecutionAuthority, InterventionStatus, ResumePolicy } from "../core/lifecycle.js";
export interface TerminalHandoffBinding {
    /** Opaque consumer-owned PTY/session identity. Never emitted by adapter status/diagnostics. */
    sessionId: string;
    /** Monotonic generation for this exact PTY/session identity. */
    sessionGeneration: number;
    /** Consumer-authenticated principal binding for the Human handoff. */
    principalBinding: string;
}
export interface TerminalHandoffInterventionRef {
    interventionId: string;
    epoch: number;
    status: "awaiting_human" | "human_active" | "verifying" | "ready_to_resume";
}
export interface TerminalHandoffTransportStatus {
    transportReady: boolean;
    humanActive: boolean;
    disconnected: boolean;
    completed: boolean;
    faulted: boolean;
    queuedEvents: number;
}
export interface TerminalHandoffStatus {
    authority: ExecutionAuthority;
    interventionStatus: InterventionStatus | null;
    interventionEpoch: number | null;
    sessionGeneration: number;
    sessionAlive: boolean;
    humanDisconnected: boolean;
    agentStateSynchronizationRequired: boolean;
    transport: TerminalHandoffTransportStatus | null;
}
export type TerminalHandoffHumanEvent = {
    kind: "input";
    data: Uint8Array;
} | {
    kind: "resize";
    rows: number;
    cols: number;
} | {
    kind: "done";
    verifying: TerminalHandoffInterventionRef;
};
export interface TerminalHandoffResumeDecision {
    epoch: number;
    resumePolicy: ResumePolicy;
    sessionAlive: boolean;
    agentStateSynchronizationRequired: boolean;
}
export interface TerminalHandoffTakeoverConfig {
    enabled: boolean;
    publicBaseUrl?: string;
    ttlMs: number;
    reconnectIdleMs?: number;
    /** Optional deployment-scoped TURN environment; omitted to use the current process environment. */
    env?: NodeJS.ProcessEnv;
}
export interface TerminalHandoffAdapterConfig {
    binding: TerminalHandoffBinding;
    takeover: TerminalHandoffTakeoverConfig;
}
export declare class TerminalHandoffAdapterError extends Error {
    readonly code: "TERMINAL_HANDOFF_BINDING_INVALID" | "TERMINAL_HANDOFF_TRANSPORT_UNAVAILABLE" | "TERMINAL_HANDOFF_TRANSPORT_NOT_READY" | "TERMINAL_HANDOFF_INTERVENTION_STALE" | "TERMINAL_HANDOFF_OUTPUT_INVALID";
    constructor(code: "TERMINAL_HANDOFF_BINDING_INVALID" | "TERMINAL_HANDOFF_TRANSPORT_UNAVAILABLE" | "TERMINAL_HANDOFF_TRANSPORT_NOT_READY" | "TERMINAL_HANDOFF_INTERVENTION_STALE" | "TERMINAL_HANDOFF_OUTPUT_INVALID", message: string);
}
/**
 * First-class composition for one bounded, consumer-owned PTY/session.
 *
 * Handoff owns authority/epoch fencing and the ephemeral Human WebRTC transport. The consumer
 * remains responsible for the PTY/process itself: after `begin()` it drains writes admitted before
 * the Agent fence, then calls `claimHumanAfterAgentDrain()` only after that physical drain is done.
 * A `done` event has already fenced the ordered Human transport and this adapter immediately moves
 * authority to `verifying`; the consumer then drains already-admitted Human writes and confirms that
 * boundary with `confirmHumanDrain()` before reporting a content-free verification result.
 *
 * PTY bytes are ephemeral method arguments/return values only. This adapter never writes them to the
 * generic Handoff state machine, checkpoints, audit records, or transport diagnostics.
 */
export declare class TerminalHandoffAdapter {
    #private;
    constructor(config: TerminalHandoffAdapterConfig);
    isPath(pathname: string): boolean;
    handle(request: Request, boundPrincipal: string | undefined): Promise<Response>;
    status(): TerminalHandoffStatus;
    /** Fence Agent authority first, then issue the still-input-fenced Human locator. */
    begin(): {
        intervention: TerminalHandoffInterventionRef;
        locator: string;
    };
    /** Cancel only before Human authority was ever granted; later phases require verification. */
    cancelBeforeHuman(awaiting: TerminalHandoffInterventionRef): Promise<TerminalHandoffStatus>;
    transportStatus(intervention: TerminalHandoffInterventionRef): TerminalHandoffTransportStatus;
    /**
     * Consumer calls this only after its PTY writer confirms the pre-fence Agent drain completed.
     * Transport readiness is checked here and transport activation is coupled to the authority claim.
     */
    claimHumanAfterAgentDrain(intervention: TerminalHandoffInterventionRef): TerminalHandoffInterventionRef;
    assertAgentInput(): void;
    assertAgentObservation(): void;
    assertAgentResize(): void;
    /** Revalidate Human authority immediately before the consumer mutates its PTY. */
    assertHumanInput(human: TerminalHandoffInterventionRef): void;
    /** Revalidate Human authority immediately before the consumer observes Human-period PTY output. */
    assertHumanObservation(human: TerminalHandoffInterventionRef): void;
    /** Revalidate Human authority immediately before the consumer resizes its PTY. */
    assertHumanResize(human: TerminalHandoffInterventionRef): void;
    /**
     * Pull one ordered Human event. Input/resize are authority-checked before exposure. For Done, the
     * transport is fenced first and authority immediately enters `verifying` before the event returns.
     */
    nextHumanEvent(human: TerminalHandoffInterventionRef): TerminalHandoffHumanEvent | undefined;
    pushHumanOutput(human: TerminalHandoffInterventionRef, data: Uint8Array): void;
    /** Record a real transport disconnect without treating it as Done or restoring Agent authority. */
    noteHumanDisconnect(human: TerminalHandoffInterventionRef): TerminalHandoffStatus;
    /** Consumer calls only after all Human writes admitted before the Done fence have drained. */
    confirmHumanDrain(verifying: TerminalHandoffInterventionRef): TerminalHandoffInterventionRef;
    reportVerification(verifying: TerminalHandoffInterventionRef, satisfied: boolean): TerminalHandoffInterventionRef;
    resume(ready: TerminalHandoffInterventionRef): TerminalHandoffResumeDecision;
    /**
     * Consumer calls only after discarding/re-reading Human-period PTY state (cwd/env/job/prompt/output
     * cursor as applicable). The adapter deliberately cannot infer or perform that semantic sync.
     */
    acknowledgeAgentStateSynchronization(): void;
    /** Exact PTY exit is terminal for this adapter instance; no replacement session is synthesized. */
    noteSessionExit(): Promise<TerminalHandoffStatus>;
    /** Tear down only the Human transport. Authority/verification state remains governed separately. */
    revokeTransport(): Promise<void>;
}
//# sourceMappingURL=terminal-handoff-adapter.d.ts.map