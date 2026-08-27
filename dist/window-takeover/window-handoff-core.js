import { spawn } from "node:child_process";
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
    #routeTtlMs;
    #initialSecureWindowPolicy;
    #sessionIds = new Set();
    #sessionsByIntervention = new Map();
    #expiryTimers = new Map();
    constructor(config) {
        const successorPolicy = normalizeSuccessorPolicy(config.successorWindowPolicy);
        if (config.successorWindowPolicy && !successorPolicy) {
            throw new WindowHandoffCoreError("SUCCESSOR_POLICY_INVALID", "Window successor policy must use same_process with a transition window between 100 and 2000 ms");
        }
        const initialSecureWindowPolicy = normalizeInitialSecureWindowPolicy(config.initialSecureWindowPolicy);
        if (config.initialSecureWindowPolicy && !initialSecureWindowPolicy) {
            throw new WindowHandoffCoreError("INITIAL_SECURE_WINDOW_POLICY_INVALID", "initial secure Window policy must use macos_local_authentication");
        }
        if (successorPolicy && initialSecureWindowPolicy) {
            throw new WindowHandoffCoreError("INITIAL_SECURE_WINDOW_POLICY_INVALID", "initial secure Window policy cannot be combined with successor-window lineage");
        }
        this.#initialSecureWindowPolicy = initialSecureWindowPolicy;
        const completionGraceMs = config.takeover.completionGraceMs ?? config.takeover.ttlMs;
        this.#routeTtlMs = config.takeover.ttlMs + completionGraceMs;
        this.#runtime = new SpawnedWebRtcRuntimeProvider(runtimeConfigForHandoff(config.runtime, config.mediaProfile, successorPolicy, initialSecureWindowPolicy));
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
        if (this.#initialSecureWindowPolicy) {
            if (request.target.windowId !== undefined) {
                throw new WindowHandoffCoreError("TARGET_INVALID", "LocalAuthentication Window Handoff resolves the current exact system window from PID only");
            }
            if (!localAuthenticationInputPolicy(request.inputPolicy)) {
                throw new WindowHandoffCoreError("INPUT_POLICY_INVALID", "LocalAuthentication Window Handoff permits Human tap only");
            }
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
    /**
     * Synchronously revoke an unclaimed locator/control-plane session.
     * Runtime cleanup remains best-effort inside TakeoverBroker; no Human generation has been claimed.
     */
    revokeUnclaimed(interventionId) {
        this.#forgetIntervention(interventionId);
        this.#broker.revokeForIntervention(interventionId);
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
        this.#sessionIds.add(sessionId);
        const sessions = this.#sessionsByIntervention.get(interventionId) ?? new Set();
        sessions.add(sessionId);
        this.#sessionsByIntervention.set(interventionId, sessions);
        const existingTimer = this.#expiryTimers.get(sessionId);
        if (existingTimer)
            clearTimeout(existingTimer);
        const timer = setTimeout(() => this.#forgetSession(sessionId), this.#routeTtlMs + 1_000);
        timer.unref();
        this.#expiryTimers.set(sessionId, timer);
    }
    #forgetIntervention(interventionId) {
        const sessions = this.#sessionsByIntervention.get(interventionId);
        if (!sessions)
            return;
        this.#sessionsByIntervention.delete(interventionId);
        for (const sessionId of [...sessions])
            this.#forgetSession(sessionId);
    }
    #forgetSession(sessionId) {
        this.#sessionIds.delete(sessionId);
        const timer = this.#expiryTimers.get(sessionId);
        if (timer)
            clearTimeout(timer);
        this.#expiryTimers.delete(sessionId);
        for (const [interventionId, sessions] of this.#sessionsByIntervention) {
            sessions.delete(sessionId);
            if (sessions.size === 0)
                this.#sessionsByIntervention.delete(interventionId);
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
function localAuthenticationInputPolicy(policy) {
    return policy.tap === true && policy.scroll === false && policy.text === false && policy.key === false;
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
function normalizeInitialSecureWindowPolicy(policy) {
    if (!policy || typeof policy !== "object" || Array.isArray(policy))
        return undefined;
    const record = policy;
    if (Object.keys(record).length !== 1 || record.mode !== "macos_local_authentication")
        return undefined;
    return { mode: "macos_local_authentication" };
}
function normalizeSuccessorPolicy(policy) {
    if (!policy)
        return undefined;
    if (!policy || typeof policy !== "object" || Array.isArray(policy))
        return undefined;
    const record = policy;
    if (Object.keys(record).some((key) => key !== "mode" && key !== "transitionWindowMs"))
        return undefined;
    if (record.mode !== "same_process")
        return undefined;
    const transitionWindowMs = record.transitionWindowMs === undefined ? 800 : Number(record.transitionWindowMs);
    if (!Number.isSafeInteger(transitionWindowMs) || transitionWindowMs < 100 || transitionWindowMs > 2_000)
        return undefined;
    return { mode: "same_process", transitionWindowMs };
}
function runtimeConfigForHandoff(runtime, mediaProfile, policy, initialSecureWindowPolicy) {
    if (!mediaProfile && !policy && !initialSecureWindowPolicy)
        return runtime;
    const baseSpawn = runtime.spawnProcess ?? spawn;
    const spawnProcess = ((command, args, options) => {
        const env = { ...(options?.env ?? {}) };
        if (mediaProfile)
            env.TAKEOVER_WEBRTC_MEDIA_PROFILE = mediaProfile;
        if (policy) {
            env.TAKEOVER_WEBRTC_WINDOW_LINEAGE = "same_process_successor";
            env.TAKEOVER_WEBRTC_WINDOW_LINEAGE_TRANSITION_MS = String(policy.transitionWindowMs);
        }
        if (initialSecureWindowPolicy) {
            env.TAKEOVER_WEBRTC_INITIAL_SECURE_WINDOW = initialSecureWindowPolicy.mode;
        }
        return baseSpawn(command, args, { ...options, env });
    });
    return { ...runtime, spawnProcess };
}
//# sourceMappingURL=window-handoff-core.js.map