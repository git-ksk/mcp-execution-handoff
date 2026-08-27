import { OPERATOR_DIAGNOSTICS_SCHEMA_VERSION, parseOperatorDiagnosticsSnapshot } from "../core/operator-diagnostics.js";
import { timingSafeEqual } from "node:crypto";
import { ExperimentalTerminalPtyAuthority, } from "../experimental/terminal-pty.js";
import { ExperimentalTerminalWebRtcTakeover, } from "../experimental/terminal-webrtc.js";
const MAX_HUMAN_OUTPUT_BYTES = 16 * 1024;
export class TerminalHandoffAdapterError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "TerminalHandoffAdapterError";
    }
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
export class TerminalHandoffAdapter {
    #binding;
    #authority;
    #transport;
    #transportRef;
    constructor(config) {
        this.#binding = normalizeAdapterBinding(config.binding);
        const unavailableDrain = async () => {
            throw new TerminalHandoffAdapterError("TERMINAL_HANDOFF_INTERVENTION_STALE", "Terminal Handoff uses explicit consumer drain acknowledgements");
        };
        this.#authority = new ExperimentalTerminalPtyAuthority(this.#binding, { drainAgentWrites: unavailableDrain, drainHumanWrites: unavailableDrain });
        this.#transport = new ExperimentalTerminalWebRtcTakeover(config.takeover);
    }
    isPath(pathname) {
        return this.#transport.isPath(pathname);
    }
    handle(request, boundPrincipal) {
        if (!boundPrincipal || !sameString(boundPrincipal, this.#binding.principalBinding)) {
            return Promise.resolve(new Response(JSON.stringify({ error: "not_found" }), {
                status: 404,
                headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
            }));
        }
        return this.#transport.handle(request);
    }
    status() {
        const authority = this.#authority.getStatus();
        const transport = this.#transportRef
            ? boundedTransportStatus(this.#transport.status(this.#transportRef.interventionId, this.#transportRef.epoch))
            : null;
        return { ...authority, transport };
    }
    operatorDiagnosticsSnapshot() {
        return terminalHandoffOperatorDiagnosticsSnapshot(this.status());
    }
    /** Fence Agent authority first, then issue the still-input-fenced Human locator. */
    begin() {
        const status = this.#authority.getStatus();
        if (this.#transportRef
            || status.authority !== "agent"
            || status.interventionStatus !== null
            || !status.sessionAlive
            || status.agentStateSynchronizationRequired) {
            throw new TerminalHandoffAdapterError("TERMINAL_HANDOFF_INTERVENTION_STALE", "Terminal Handoff cannot begin until the prior lifecycle and state synchronization are complete");
        }
        const intervention = this.#authority.beginFence(this.#binding);
        const ref = publicIntervention(intervention);
        try {
            const locator = this.#transport.start(ref.interventionId, ref.epoch, this.#binding.principalBinding);
            this.#transportRef = { interventionId: ref.interventionId, epoch: ref.epoch };
            return { intervention: ref, locator };
        }
        catch (error) {
            void error;
            this.#authority.cancelBeforeHuman(this.#binding, ref.interventionId, ref.epoch);
            throw new TerminalHandoffAdapterError("TERMINAL_HANDOFF_TRANSPORT_UNAVAILABLE", "Terminal Human transport could not be started; no Human authority was granted");
        }
    }
    /** Cancel only before Human authority was ever granted; later phases require verification. */
    async cancelBeforeHuman(awaiting) {
        this.#requireTransportRef(awaiting);
        const authority = this.#authority.getStatus();
        if (authority.interventionStatus !== "awaiting_human"
            || authority.interventionEpoch !== awaiting.epoch) {
            throw new TerminalHandoffAdapterError("TERMINAL_HANDOFF_INTERVENTION_STALE", "Terminal Handoff can be cancelled only before Human authority is claimed");
        }
        const ref = this.#transportRef;
        this.#transportRef = undefined;
        await this.#transport.revoke(ref.interventionId, ref.epoch).catch(() => undefined);
        return {
            ...this.#authority.cancelBeforeHuman(this.#binding, awaiting.interventionId, awaiting.epoch),
            transport: null,
        };
    }
    transportStatus(intervention) {
        this.#requireTransportRef(intervention);
        return boundedTransportStatus(this.#transport.status(intervention.interventionId, intervention.epoch));
    }
    /**
     * Consumer calls this only after its PTY writer confirms the pre-fence Agent drain completed.
     * Transport readiness is checked here and transport activation is coupled to the authority claim.
     */
    claimHumanAfterAgentDrain(intervention) {
        this.#requireTransportRef(intervention);
        const transport = this.#transport.status(intervention.interventionId, intervention.epoch);
        if (!transport.transportReady || transport.disconnected || transport.completed || transport.faulted) {
            throw new TerminalHandoffAdapterError("TERMINAL_HANDOFF_TRANSPORT_NOT_READY", "Terminal Human authority cannot be claimed until the exact transport generation is ready");
        }
        const human = this.#authority.claimHumanAfterAgentDrain(this.#binding, intervention.interventionId, intervention.epoch);
        try {
            this.#transport.activateHuman(intervention.interventionId, intervention.epoch);
        }
        catch (error) {
            this.#authority.noteHumanDisconnect(this.#binding, human.id, human.epoch);
            void error;
            throw new TerminalHandoffAdapterError("TERMINAL_HANDOFF_TRANSPORT_UNAVAILABLE", "Terminal Human transport activation failed after authority claim; Agent remains fenced");
        }
        return publicIntervention(human);
    }
    assertAgentInput() { this.#authority.assertAgentInput(this.#binding); }
    assertAgentObservation() { this.#authority.assertAgentObservation(this.#binding); }
    assertAgentResize() { this.#authority.assertAgentResize(this.#binding); }
    /** Revalidate Human authority immediately before the consumer mutates its PTY. */
    assertHumanInput(human) {
        this.#authority.assertHumanInput(this.#binding, human.interventionId, human.epoch);
    }
    /** Revalidate Human authority immediately before the consumer observes Human-period PTY output. */
    assertHumanObservation(human) {
        this.#authority.assertHumanObservation(this.#binding, human.interventionId, human.epoch);
    }
    /** Revalidate Human authority immediately before the consumer resizes its PTY. */
    assertHumanResize(human) {
        this.#authority.assertHumanResize(this.#binding, human.interventionId, human.epoch);
    }
    /**
     * Pull one ordered Human event. Input/resize are authority-checked before exposure. For Done, the
     * transport is fenced first and authority immediately enters `verifying` before the event returns.
     */
    nextHumanEvent(human) {
        this.#requireTransportRef(human);
        const event = this.#transport.nextEvent(human.interventionId, human.epoch);
        if (!event)
            return undefined;
        if (event.kind === "input") {
            this.#authority.assertHumanInput(this.#binding, human.interventionId, human.epoch);
            return { kind: "input", data: Uint8Array.from(Buffer.from(event.dataBase64, "base64")) };
        }
        if (event.kind === "resize") {
            this.#authority.assertHumanResize(this.#binding, human.interventionId, human.epoch);
            return { kind: "resize", rows: event.rows, cols: event.cols };
        }
        this.#transport.fenceHuman(human.interventionId, human.epoch);
        const verifying = this.#authority.markHumanDoneFence(this.#binding, human.interventionId, human.epoch);
        // Ordered Done has already fenced/revoked the runtime and capability. Release only the completed
        // transport bookkeeping; authority remains verifying until consumer drain + verification.
        this.#transport.releaseCompleted(human.interventionId, human.epoch);
        this.#transportRef = undefined;
        return { kind: "done", verifying: publicIntervention(verifying) };
    }
    pushHumanOutput(human, data) {
        this.#requireTransportRef(human);
        this.#authority.assertHumanObservation(this.#binding, human.interventionId, human.epoch);
        if (!(data instanceof Uint8Array) || data.byteLength < 1 || data.byteLength > MAX_HUMAN_OUTPUT_BYTES) {
            throw new TerminalHandoffAdapterError("TERMINAL_HANDOFF_OUTPUT_INVALID", "Terminal Human-visible output must contain 1-16384 ephemeral bytes");
        }
        this.#transport.pushOutput(human.interventionId, human.epoch, Buffer.from(data).toString("base64"));
    }
    /** Record a real transport disconnect without treating it as Done or restoring Agent authority. */
    noteHumanDisconnect(human) {
        this.#requireTransportRef(human);
        const transport = this.#transport.status(human.interventionId, human.epoch);
        if (!transport.disconnected || transport.completed) {
            throw new TerminalHandoffAdapterError("TERMINAL_HANDOFF_TRANSPORT_UNAVAILABLE", "Terminal disconnect acknowledgement requires a disconnected, incomplete Human transport");
        }
        this.#authority.noteHumanDisconnect(this.#binding, human.interventionId, human.epoch);
        return this.status();
    }
    /** Consumer calls only after all Human writes admitted before the Done fence have drained. */
    confirmHumanDrain(verifying) {
        const active = this.#authority.confirmHumanWritesDrained(this.#binding, verifying.interventionId, verifying.epoch);
        return publicIntervention(active);
    }
    reportVerification(verifying, satisfied) {
        const active = this.#authority.reportVerification(this.#binding, verifying.interventionId, verifying.epoch, satisfied);
        return publicIntervention(active);
    }
    resume(ready) {
        return publicResume(this.#authority.resumeAgent(this.#binding, ready.interventionId, ready.epoch));
    }
    /**
     * Consumer calls only after discarding/re-reading Human-period PTY state (cwd/env/job/prompt/output
     * cursor as applicable). The adapter deliberately cannot infer or perform that semantic sync.
     */
    acknowledgeAgentStateSynchronization() {
        this.#authority.acknowledgeAgentStateSynchronization(this.#binding);
    }
    /** Exact PTY exit is terminal for this adapter instance; no replacement session is synthesized. */
    async noteSessionExit() {
        const authority = this.#authority.noteSessionExit(this.#binding);
        const ref = this.#transportRef;
        if (ref) {
            this.#transportRef = undefined;
            await this.#transport.revoke(ref.interventionId, ref.epoch).catch(() => undefined);
        }
        return { ...authority, transport: null };
    }
    /** Tear down only the Human transport. Authority/verification state remains governed separately. */
    async revokeTransport() {
        const ref = this.#transportRef;
        if (!ref)
            return;
        const authority = this.#authority.getStatus();
        if (authority.interventionStatus === "human_active" && authority.interventionEpoch === ref.epoch) {
            this.#transport.fenceHuman(ref.interventionId, ref.epoch);
            this.#authority.noteHumanDisconnect(this.#binding, ref.interventionId, ref.epoch);
        }
        this.#transportRef = undefined;
        await this.#transport.revoke(ref.interventionId, ref.epoch).catch(() => undefined);
    }
    #requireTransportRef(intervention) {
        const ref = this.#transportRef;
        if (!ref || ref.interventionId !== intervention.interventionId || ref.epoch !== intervention.epoch) {
            throw new TerminalHandoffAdapterError("TERMINAL_HANDOFF_INTERVENTION_STALE", "Terminal Handoff intervention no longer matches the active Human transport");
        }
    }
}
function boundedTransportStatus(status) {
    return {
        transportReady: status.transportReady,
        humanActive: status.humanActive,
        disconnected: status.disconnected,
        completed: status.completed,
        faulted: status.faulted,
        queuedEvents: status.queuedEvents,
    };
}
function publicIntervention(intervention) {
    if (![
        "awaiting_human",
        "human_active",
        "verifying",
        "ready_to_resume",
    ].includes(intervention.status)) {
        throw new TerminalHandoffAdapterError("TERMINAL_HANDOFF_INTERVENTION_STALE", "Terminal Handoff intervention status is not externally actionable");
    }
    return {
        interventionId: intervention.id,
        epoch: intervention.epoch,
        status: intervention.status,
    };
}
function publicResume(decision) {
    return {
        epoch: decision.epoch,
        resumePolicy: decision.resumePolicy,
        sessionAlive: decision.sessionAlive,
        agentStateSynchronizationRequired: decision.agentStateSynchronizationRequired,
    };
}
function normalizeAdapterBinding(binding) {
    const sessionId = binding.sessionId.trim();
    const principalBinding = binding.principalBinding.trim();
    if (!sessionId
        || sessionId.length > 200
        || !/^[A-Za-z0-9._:-]+$/.test(sessionId)
        || !Number.isSafeInteger(binding.sessionGeneration)
        || binding.sessionGeneration <= 0
        || !/^[a-f0-9]{64}$/.test(principalBinding)) {
        throw new TerminalHandoffAdapterError("TERMINAL_HANDOFF_BINDING_INVALID", "Terminal Handoff requires an opaque session, positive generation, and 64-hex principal binding");
    }
    return { sessionId, sessionGeneration: binding.sessionGeneration, principalBinding };
}
function sameString(left, right) {
    const expected = Buffer.from(left, "utf8");
    const supplied = Buffer.from(right, "utf8");
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
export function terminalHandoffOperatorDiagnosticsSnapshot(status) {
    let health = "idle";
    let failureCategory;
    if (!status.sessionAlive) {
        health = "failed";
        failureCategory = "target";
    }
    else if (status.transport?.faulted) {
        health = "failed";
        failureCategory = "transport";
    }
    else if (status.humanDisconnected || status.transport?.disconnected || status.agentStateSynchronizationRequired) {
        health = "degraded";
        if (status.humanDisconnected || status.transport?.disconnected)
            failureCategory = "transport";
    }
    else if (status.interventionStatus === "awaiting_human" && !status.transport?.transportReady) {
        health = "starting";
    }
    else if (status.interventionStatus !== null || status.transport?.transportReady) {
        health = "available";
    }
    return parseOperatorDiagnosticsSnapshot({
        version: OPERATOR_DIAGNOSTICS_SCHEMA_VERSION,
        source: "terminal_handoff",
        health,
        authority: status.authority,
        ...(status.interventionStatus === null ? {} : { phase: status.interventionStatus }),
        ...(failureCategory ? { failureCategory } : {}),
        terminal: {
            namespace: "terminal_session",
            alive: status.sessionAlive,
            humanDisconnected: status.humanDisconnected,
            synchronizationRequired: status.agentStateSynchronizationRequired
        },
        transport: status.transport === null ? null : {
            namespace: "terminal_webrtc",
            ready: status.transport.transportReady,
            disconnected: status.transport.disconnected,
            completed: status.transport.completed,
            faulted: status.transport.faulted,
            queuedEvents: status.transport.queuedEvents
        }
    });
}
//# sourceMappingURL=terminal-handoff-adapter.js.map