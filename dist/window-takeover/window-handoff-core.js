import { TakeoverBroker } from "../browser-takeover/broker.js";
import { SpawnedWebRtcRuntimeProvider } from "../browser-takeover/webrtc-runtime-diagnostics.js";
export class WindowHandoffCoreError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "WindowHandoffCoreError";
    }
}
/** Shared bounded-window WebRTC/session composition used by Browser and Window facades. */
export class WindowHandoffCore {
    #runtime;
    #broker;
    #ttlMs;
    #sessionIds = new Set();
    #sessionByIntervention = new Map();
    #expiryTimers = new Map();
    constructor(config) {
        this.#ttlMs = config.takeover.ttlMs;
        this.#runtime = new SpawnedWebRtcRuntimeProvider(config.runtime);
        this.#broker = new TakeoverBroker(webRtcOnlySurfaceAdapter(), config.takeover, undefined, this.#runtime, config.onComplete ? { completed: config.onComplete } : {});
    }
    isEnabled() {
        return this.#broker.isEnabled();
    }
    isPath(pathname) {
        return this.#broker.isPath(pathname);
    }
    ownsPath(pathname) {
        if (!this.isEnabled())
            return false;
        if (pathname === "/takeover/webrtc-client.js")
            return true;
        const sessionId = takeoverSessionIdFromPath(pathname);
        return sessionId !== undefined && this.#sessionIds.has(sessionId);
    }
    start(request) {
        if (!validTarget(request.target)) {
            throw new WindowHandoffCoreError("TARGET_INVALID", "bounded Window Handoff requires a positive process id and an optional positive window id");
        }
        if (!validInputPolicy(request.inputPolicy)) {
            throw new WindowHandoffCoreError("INPUT_POLICY_INVALID", "bounded Window Handoff requires an explicit Human input policy");
        }
        const locator = this.#broker.createWebRtcLink(request.intervention, request.principalBinding, request.target, request.inputPolicy);
        if (!locator)
            throw new WindowHandoffCoreError("UNAVAILABLE", "bounded Window WebRTC Handoff is unavailable");
        const sessionId = takeoverSessionIdFromPath(new URL(locator).pathname);
        if (!sessionId)
            throw new WindowHandoffCoreError("UNAVAILABLE", "bounded Window Handoff locator is invalid");
        this.#rememberSession(request.intervention.id, sessionId);
        return locator;
    }
    async revoke(interventionId) {
        this.#forgetIntervention(interventionId);
        await this.#broker.revokeWebRtcForIntervention(interventionId);
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
export function validWindowHandoffTarget(target) {
    return Number.isSafeInteger(target.processId) && target.processId > 0 &&
        (target.windowId === undefined || (Number.isSafeInteger(target.windowId) && target.windowId > 0));
}
export function validWindowHandoffInputPolicy(policy) {
    if (!policy || typeof policy !== "object" || Array.isArray(policy))
        return false;
    const record = policy;
    const keys = ["tap", "scroll", "text", "key"];
    return Object.keys(record).length === keys.length
        && Object.keys(record).every((key) => keys.includes(key))
        && keys.every((key) => typeof record[key] === "boolean");
}
function validTarget(target) {
    return validWindowHandoffTarget(target);
}
function validInputPolicy(policy) {
    return validWindowHandoffInputPolicy(policy);
}
function takeoverSessionIdFromPath(pathname) {
    const page = /^\/takeover\/([A-Za-z0-9-]{8,100})$/.exec(pathname);
    if (page)
        return page[1];
    const api = /^\/takeover\/api\/[a-z0-9-]+\/([A-Za-z0-9-]{8,100})$/.exec(pathname);
    return api?.[1];
}
function webRtcOnlySurfaceAdapter() {
    const unavailable = async () => {
        throw new WindowHandoffCoreError("UNAVAILABLE", "HTTP frame/input takeover is unavailable through bounded Window Handoff");
    };
    return {
        captureHumanTakeoverFrame: unavailable,
        tapHumanTakeover: unavailable,
        scrollHumanTakeover: unavailable,
        insertHumanTakeoverText: unavailable,
        pressHumanTakeoverKey: unavailable
    };
}
//# sourceMappingURL=window-handoff-core.js.map