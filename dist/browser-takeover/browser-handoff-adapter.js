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
    constructor(config) {
        this.#runtime = new SpawnedWebRtcRuntimeProvider(config.runtime);
        this.#broker = new TakeoverBroker(webRtcOnlyBrowserAdapter(), config.takeover, undefined, this.#runtime);
    }
    isEnabled() {
        return this.#broker.isEnabled();
    }
    isPath(pathname) {
        return this.#broker.isPath(pathname);
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
        const locator = this.#broker.createWebRtcLink(request.intervention, request.principalBinding, request.target);
        if (!locator) {
            throw new BrowserHandoffAdapterError("BROWSER_HANDOFF_UNAVAILABLE", "Browser WebRTC Handoff is unavailable");
        }
        return locator;
    }
    async revoke(interventionId) {
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
}
function validTarget(target) {
    return Number.isSafeInteger(target.processId) && target.processId > 0 &&
        (target.windowId === undefined || (Number.isSafeInteger(target.windowId) && target.windowId > 0));
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