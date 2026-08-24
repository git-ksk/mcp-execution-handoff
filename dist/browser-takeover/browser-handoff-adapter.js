import { TakeoverBroker } from "./broker.js";
import { SpawnedWebRtcRuntimeProvider } from "./webrtc-runtime-diagnostics.js";
export class BrowserHandoffAdapterError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "BrowserHandoffAdapterError";
    }
}
/**
 * First-class Browser WebRTC Handoff composition for standalone MCP consumers.
 *
 * Consumers own why Human intervention is required, browser/profile lifecycle, semantic/input
 * policy, and fresh post-Human verification. Handoff owns the short-lived Browser Handoff
 * locator, WebRTC runtime, direct/relay transport behavior, exact target binding, reconnect
 * generation fencing, revoke, and bounded transport diagnostics.
 *
 * This adapter deliberately has no generic HTTP-frame start method. A missing/unavailable WebRTC
 * runtime therefore cannot silently downgrade a canonical Browser Handoff into screenshot polling.
 */
export class BrowserHandoffAdapter {
    #runtime;
    #broker;
    #ttlMs;
    #sessionIds = new Set();
    #sessionByIntervention = new Map();
    #expiryTimers = new Map();
    constructor(config) {
        this.#ttlMs = config.takeover.ttlMs;
        this.#runtime = new SpawnedWebRtcRuntimeProvider(config.runtime);
        this.#broker = new TakeoverBroker(webRtcOnlyBrowserAdapter(), config.takeover, undefined, this.#runtime, config.onComplete ? { completed: config.onComplete } : {});
    }
    isEnabled() {
        return this.#broker.isEnabled();
    }
    isPath(pathname) {
        return this.#broker.isPath(pathname);
    }
    /**
     * Return whether this high-level adapter owns the concrete Browser Handoff route.
     *
     * Consumers that also host a low-level `TakeoverBroker` can use this to route only WebRTC
     * sessions created by this adapter here, while leaving legacy HTTP/native sessions on the other
     * broker. The shared WebRTC client script is adapter-owned; the legacy client script is not.
     */
    ownsPath(pathname) {
        if (!this.isEnabled())
            return false;
        if (pathname === "/takeover/webrtc-client.js")
            return true;
        const sessionId = takeoverSessionIdFromPath(pathname);
        return sessionId !== undefined && this.#sessionIds.has(sessionId);
    }
    /**
     * Issue one short-lived locator for an exact browser target.
     *
     * Locator issuance only means the control-plane session exists. Runtime/media readiness is
     * established later by the existing WebRTC prepare/connect path, which preserves the host-window
     * and first-media-frame readiness gates before an answer is returned.
     */
    start(request) {
        if (!validTarget(request.target)) {
            throw new BrowserHandoffAdapterError("BROWSER_HANDOFF_TARGET_INVALID", "Browser Handoff requires a positive process id and an optional positive window id");
        }
        if (!validInputPolicy(request.inputPolicy)) {
            throw new BrowserHandoffAdapterError("BROWSER_HANDOFF_INPUT_POLICY_INVALID", "Browser Handoff requires an explicit bounded Human input policy");
        }
        const locator = this.#broker.createWebRtcLink(request.intervention, request.principalBinding, request.target, request.inputPolicy);
        if (!locator) {
            throw new BrowserHandoffAdapterError("BROWSER_HANDOFF_UNAVAILABLE", "Browser WebRTC Handoff is unavailable");
        }
        const sessionId = takeoverSessionIdFromPath(new URL(locator).pathname);
        if (!sessionId) {
            throw new BrowserHandoffAdapterError("BROWSER_HANDOFF_UNAVAILABLE", "Browser WebRTC Handoff locator is invalid");
        }
        this.#rememberSession(request.intervention.id, sessionId);
        return locator;
    }
    async revoke(interventionId) {
        this.#forgetIntervention(interventionId);
        await this.#broker.revokeWebRtcForIntervention(interventionId);
    }
    /** Alias for consumers that already use broker-style lifecycle naming. */
    async revokeForIntervention(interventionId) {
        await this.revoke(interventionId);
    }
    handle(request, boundPrincipal) {
        return this.#broker.handle(request, boundPrincipal);
    }
    diagnosticsSnapshot() {
        return this.#runtime.diagnosticsSnapshot();
    }
    latencySnapshot() {
        return this.#runtime.latencySnapshot();
    }
    #rememberSession(interventionId, sessionId) {
        const previous = this.#sessionByIntervention.get(interventionId);
        if (previous && previous !== sessionId)
            this.#forgetSession(previous);
        this.#sessionIds.add(sessionId);
        this.#sessionByIntervention.set(interventionId, sessionId);
        const existingTimer = this.#expiryTimers.get(sessionId);
        if (existingTimer)
            clearTimeout(existingTimer);
        const timer = setTimeout(() => this.#forgetSession(sessionId), this.#ttlMs + 1_000);
        timer.unref();
        this.#expiryTimers.set(sessionId, timer);
    }
    #forgetIntervention(interventionId) {
        const sessionId = this.#sessionByIntervention.get(interventionId);
        if (!sessionId)
            return;
        this.#sessionByIntervention.delete(interventionId);
        this.#forgetSession(sessionId);
    }
    #forgetSession(sessionId) {
        this.#sessionIds.delete(sessionId);
        const timer = this.#expiryTimers.get(sessionId);
        if (timer)
            clearTimeout(timer);
        this.#expiryTimers.delete(sessionId);
        for (const [interventionId, currentSessionId] of this.#sessionByIntervention) {
            if (currentSessionId === sessionId)
                this.#sessionByIntervention.delete(interventionId);
        }
    }
}
function takeoverSessionIdFromPath(pathname) {
    const page = /^\/takeover\/([A-Za-z0-9-]{8,100})$/.exec(pathname);
    if (page)
        return page[1];
    const api = /^\/takeover\/api\/[a-z0-9-]+\/([A-Za-z0-9-]{8,100})$/.exec(pathname);
    return api?.[1];
}
function validTarget(target) {
    return Number.isSafeInteger(target.processId) && target.processId > 0 &&
        (target.windowId === undefined || (Number.isSafeInteger(target.windowId) && target.windowId > 0));
}
function validInputPolicy(policy) {
    if (!policy || typeof policy !== "object" || Array.isArray(policy))
        return false;
    const record = policy;
    const keys = ["tap", "scroll", "text", "key"];
    return Object.keys(record).length === keys.length
        && Object.keys(record).every((key) => keys.includes(key))
        && keys.every((key) => typeof record[key] === "boolean");
}
function webRtcOnlyBrowserAdapter() {
    const unavailable = async () => {
        throw new BrowserHandoffAdapterError("BROWSER_HANDOFF_UNAVAILABLE", "HTTP frame/input takeover is not available through BrowserHandoffAdapter");
    };
    return {
        captureHumanTakeoverFrame: unavailable,
        tapHumanTakeover: unavailable,
        scrollHumanTakeover: unavailable,
        insertHumanTakeoverText: unavailable,
        pressHumanTakeoverKey: unavailable
    };
}
//# sourceMappingURL=browser-handoff-adapter.js.map