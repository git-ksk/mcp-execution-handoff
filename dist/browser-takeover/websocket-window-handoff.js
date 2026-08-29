import { TakeoverBroker } from "../browser-takeover/broker.js";
import { validWindowHandoffInputPolicy, validWindowHandoffTarget } from "../window-takeover/window-handoff-core.js";
import { ExperimentalWebSocketBrokerBinding } from "./websocket-broker-binding.js";
const EDITABLE_REGIONS_REFRESH_MS = 500;
export class ExperimentalWebSocketWindowHandoffError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "ExperimentalWebSocketWindowHandoffError";
    }
}
/**
 * Private Generic Window composition for the #40 WSS experiment.
 *
 * Consumers still provide only Handoff semantics plus an exact Window target. WSS framing,
 * bootstrap tickets, connection state and frame pumping remain Handoff-owned. The exact target is
 * retained only in process memory and is never sent to the browser or stored in transport messages.
 */
export class ExperimentalWebSocketWindowHandoff {
    #broker;
    #binding;
    #surface;
    #frameIntervalMs;
    #sessionsByIntervention = new Map();
    #sessionsById = new Map();
    #onDiagnosticEvent;
    #onAuthorityReleased;
    constructor(config) {
        this.#surface = config.surface;
        this.#onDiagnosticEvent = config.onDiagnosticEvent;
        this.#onAuthorityReleased = config.onAuthorityReleased;
        this.#frameIntervalMs = boundedFrameInterval(config.frameIntervalMs);
        this.#broker = new TakeoverBroker(unavailableHttpSurface(), config.takeover, undefined, undefined, config.onComplete || config.onAuthorityReleased
            ? {
                completed: async (event) => {
                    this.#forgetMatchingSession(event.interventionId, event.epoch);
                    await config.onAuthorityReleased?.({ ...event, disposition: "completed", reason: "human_completed" });
                    await config.onComplete?.(event);
                }
            }
            : {
                completed: (event) => {
                    this.#forgetMatchingSession(event.interventionId, event.epoch);
                }
            });
        this.#binding = new ExperimentalWebSocketBrokerBinding(this.#broker, {
            allowedOrigins: config.allowedOrigins,
            onInput: (binding, input) => this.#dispatchInput(binding.interventionId, binding.epoch, input),
            ...(config.maxInboundBytes === undefined ? {} : { maxInboundBytes: config.maxInboundBytes }),
            ...(config.onDiagnosticEvent ? { onDiagnosticEvent: config.onDiagnosticEvent } : {})
        });
    }
    start(request) {
        if (!validWindowHandoffTarget(request.target)) {
            throw new ExperimentalWebSocketWindowHandoffError("WINDOW_HANDOFF_TARGET_INVALID", "bounded Window WSS Handoff requires a positive process id and an optional positive window id");
        }
        if (!validWindowHandoffInputPolicy(request.inputPolicy)) {
            throw new ExperimentalWebSocketWindowHandoffError("WINDOW_HANDOFF_INPUT_POLICY_INVALID", "bounded Window WSS Handoff requires an explicit Human input policy");
        }
        const existing = this.#sessionsByIntervention.get(request.intervention.id);
        if (existing) {
            if (request.intervention.epoch < existing.epoch) {
                throw new ExperimentalWebSocketWindowHandoffError("WINDOW_HANDOFF_UNAVAILABLE", "stale Window WSS Handoff epoch is unavailable");
            }
            if (request.intervention.epoch === existing.epoch) {
                if (existing.principalBinding !== request.principalBinding
                    || !sameTarget(existing.target, request.target)
                    || !sameInputPolicy(existing.inputPolicy, request.inputPolicy)) {
                    throw new ExperimentalWebSocketWindowHandoffError("WINDOW_HANDOFF_UNAVAILABLE", "active Window WSS Handoff binding cannot be widened or replaced");
                }
                return existing.locator;
            }
            this.revoke(request.intervention.id);
        }
        const locator = this.#binding.createLink(request.intervention, request.principalBinding, request.inputPolicy);
        if (!locator) {
            throw new ExperimentalWebSocketWindowHandoffError("WINDOW_HANDOFF_UNAVAILABLE", "bounded Window WSS Handoff is unavailable");
        }
        const sessionId = sessionIdFromLocator(locator);
        if (!sessionId) {
            this.#broker.revokeForIntervention(request.intervention.id);
            throw new ExperimentalWebSocketWindowHandoffError("WINDOW_HANDOFF_UNAVAILABLE", "bounded Window WSS locator is invalid");
        }
        const target = { ...request.target };
        const inputPolicy = { ...request.inputPolicy };
        let state;
        const timer = setInterval(() => void this.#pumpFrame(state), this.#frameIntervalMs);
        timer.unref();
        state = {
            interventionId: request.intervention.id,
            epoch: request.intervention.epoch,
            principalBinding: request.principalBinding,
            sessionId,
            locator,
            target,
            inputPolicy,
            timer,
            captureInFlight: false,
            editableRegionsFingerprint: "",
            editableRegionsLastSentAt: 0
        };
        this.#sessionsByIntervention.set(state.interventionId, state);
        this.#sessionsById.set(state.sessionId, state);
        return locator;
    }
    authorizeClientPage(sessionId, boundPrincipal) {
        return this.#sessionsById.has(sessionId) && this.#binding.validateLocator(sessionId, boundPrincipal);
    }
    /** @internal Content-free WSS ingress diagnostics for managed physical acceptance. */
    diagnosticsSnapshot() {
        return this.#binding.diagnosticsSnapshot();
    }
    handle(request, boundPrincipal) {
        return this.#binding.handleBootstrap(request, boundPrincipal)
            ?? this.#broker.handle(request, boundPrincipal);
    }
    handleUpgrade(request, socket, head) {
        return this.#binding.handleUpgrade(request, socket, head);
    }
    ownsPath(pathname) {
        const sessionId = sessionIdFromPath(pathname);
        return sessionId !== undefined && this.#sessionsById.has(sessionId);
    }
    revoke(interventionId) {
        if (this.#sessionsByIntervention.has(interventionId))
            this.#onDiagnosticEvent?.("session_revoked");
        this.#forgetIntervention(interventionId);
        this.#broker.revokeForIntervention(interventionId);
    }
    async #pumpFrame(state) {
        if (state.captureInFlight || this.#sessionsById.get(state.sessionId) !== state)
            return;
        if (!this.#binding.hasActiveConnection(state.sessionId))
            return;
        state.captureInFlight = true;
        let frame;
        try {
            frame = await this.#surface.captureExactWindow(state.target);
        }
        catch (error) {
            const disposition = this.#surface.captureFailureDisposition?.(error) ?? "authority_lost";
            if (disposition === "recoverable") {
                this.#onDiagnosticEvent?.("session_retained");
                return;
            }
            this.revoke(state.interventionId);
            void Promise.resolve(this.#onAuthorityReleased?.({
                interventionId: state.interventionId,
                epoch: state.epoch,
                disposition: "revoked",
                reason: "authority_lost"
            })).catch(() => undefined);
            return;
        }
        finally {
            state.captureInFlight = false;
        }
        if (this.#sessionsById.get(state.sessionId) !== state)
            return;
        const editableRegions = this.#surface.editableRegionsSnapshot?.() ?? [];
        const editableFingerprint = editableRegions.map((region) => region.join(",")).join(";");
        const now = Date.now();
        const editableRegionsChanged = editableFingerprint !== state.editableRegionsFingerprint;
        const editableRegionsRefreshDue = editableRegions.length > 0
            && state.editableRegionsLastSentAt > 0
            && now - state.editableRegionsLastSentAt >= EDITABLE_REGIONS_REFRESH_MS;
        if (editableRegionsChanged || editableRegionsRefreshDue) {
            try {
                await this.#binding.pushControl(state.sessionId, { kind: "editableRegions", regions: editableRegions });
                state.editableRegionsFingerprint = editableFingerprint;
                state.editableRegionsLastSentAt = now;
            }
            catch {
                // Retry on the next frame; stale editable geometry must not be extended after a failed send.
            }
        }
        try {
            await this.#binding.pushFrame(state.sessionId, frame);
        }
        catch {
            // The channel itself fails closed and releases the generation on transport/backpressure
            // failure. A later authenticated reconnect may claim only a fresh generation.
        }
    }
    async #dispatchInput(interventionId, epoch, input) {
        const state = this.#sessionsByIntervention.get(interventionId);
        if (!state || state.epoch !== epoch || this.#sessionsById.get(state.sessionId) !== state) {
            throw new ExperimentalWebSocketWindowHandoffError("WINDOW_HANDOFF_UNAVAILABLE", "bounded Window WSS target binding is stale");
        }
        switch (input.kind) {
            case "tap":
                await this.#surface.tapExactWindow(state.target, input.x, input.y);
                return;
            case "scroll":
                await this.#surface.scrollExactWindow(state.target, input.deltaY);
                return;
            case "text":
                await this.#surface.insertExactWindowText(state.target, input.text);
                return;
            case "key":
                await this.#surface.pressExactWindowKey(state.target, input.key);
                return;
        }
    }
    #forgetMatchingSession(interventionId, epoch) {
        const state = this.#sessionsByIntervention.get(interventionId);
        if (state?.epoch === epoch)
            this.#forgetSession(state);
    }
    #forgetIntervention(interventionId) {
        const state = this.#sessionsByIntervention.get(interventionId);
        if (state)
            this.#forgetSession(state);
    }
    #forgetSession(state) {
        if (this.#sessionsByIntervention.get(state.interventionId) === state) {
            this.#sessionsByIntervention.delete(state.interventionId);
        }
        if (this.#sessionsById.get(state.sessionId) === state)
            this.#sessionsById.delete(state.sessionId);
        clearInterval(state.timer);
    }
}
function unavailableHttpSurface() {
    const unavailable = async () => {
        throw new ExperimentalWebSocketWindowHandoffError("WINDOW_HANDOFF_UNAVAILABLE", "legacy HTTP frame/input is unavailable through bounded Window WSS Handoff");
    };
    return {
        captureHumanTakeoverFrame: unavailable,
        tapHumanTakeover: unavailable,
        scrollHumanTakeover: unavailable,
        insertHumanTakeoverText: unavailable,
        pressHumanTakeoverKey: unavailable
    };
}
function boundedFrameInterval(value) {
    const resolved = value ?? 75;
    if (!Number.isInteger(resolved) || resolved < 50 || resolved > 2_000) {
        throw new Error("Window WSS frame interval must be an integer between 50ms and 2000ms");
    }
    return resolved;
}
function sameTarget(left, right) {
    return left.processId === right.processId && left.windowId === right.windowId;
}
function sameInputPolicy(left, right) {
    return left.tap === right.tap
        && left.scroll === right.scroll
        && left.text === right.text
        && left.key === right.key;
}
function sessionIdFromLocator(locator) {
    try {
        return sessionIdFromPath(new URL(locator).pathname);
    }
    catch {
        return undefined;
    }
}
function sessionIdFromPath(pathname) {
    const page = /^\/takeover\/([A-Za-z0-9-]{8,100})$/.exec(pathname);
    if (page)
        return page[1];
    const api = /^\/takeover\/api\/[a-z0-9-]+\/([A-Za-z0-9-]{8,100})$/.exec(pathname);
    if (api)
        return api[1];
    const ws = /^\/takeover\/ws\/([A-Za-z0-9-]{8,100})$/.exec(pathname);
    return ws?.[1];
}
//# sourceMappingURL=websocket-window-handoff.js.map