import { webRtcOperatorDiagnosticsSnapshot } from "./webrtc-diagnostics.js";
import { ManagedWindowHandoffRuntime } from "./managed-handoff-runtime.js";
import { WindowHandoffCore, WindowHandoffCoreError } from "../window-takeover/window-handoff-core.js";
export class BrowserHandoffAdapterError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "BrowserHandoffAdapterError";
    }
}
/**
 * First-class Browser Handoff composition for standalone MCP consumers.
 *
 * Direct WebRTC remains unchanged by default. When managed fallback is configured, Handoff owns
 * the strict direct WebRTC -> WSS -> optional TURN transition while the consumer keeps one locator
 * and the same Browser lifecycle API.
 */
export class BrowserHandoffAdapter {
    #core;
    constructor(config) {
        try {
            this.#core = config.managedFallback
                ? new ManagedWindowHandoffRuntime({
                    takeover: config.takeover,
                    runtime: config.runtime,
                    managedFallback: config.managedFallback,
                    ...(config.onComplete ? { onComplete: config.onComplete } : {})
                })
                : new WindowHandoffCore(config);
        }
        catch (error) {
            throw translateError(error);
        }
    }
    isEnabled() { return this.#core.isEnabled(); }
    isPath(pathname) { return this.#core.isPath(pathname); }
    ownsPath(pathname) { return this.#core.ownsPath(pathname); }
    start(request) {
        try {
            return this.#core.start(request);
        }
        catch (error) {
            throw translateError(error);
        }
    }
    async revoke(interventionId) { await this.#core.revoke(interventionId); }
    async revokeForIntervention(interventionId) { await this.revoke(interventionId); }
    handle(request, boundPrincipal) {
        return this.#core.handle(request, boundPrincipal);
    }
    /** Route Node HTTP upgrades only when managed WSS is the active Handoff transport. */
    handleUpgrade(request, socket, head) {
        return this.#core instanceof ManagedWindowHandoffRuntime
            ? this.#core.handleUpgrade(request, socket, head)
            : false;
    }
    diagnosticsSnapshot() { return this.#core.diagnosticsSnapshot(); }
    operatorDiagnosticsSnapshot() {
        return this.#core instanceof ManagedWindowHandoffRuntime
            ? this.#core.operatorDiagnosticsSnapshot("browser_handoff")
            : webRtcOperatorDiagnosticsSnapshot("browser_handoff", this.#core.diagnosticsSnapshot());
    }
    latencySnapshot() { return this.#core.latencySnapshot(); }
}
function translateError(error) {
    if (!(error instanceof WindowHandoffCoreError)) {
        return error instanceof Error
            ? new BrowserHandoffAdapterError("BROWSER_HANDOFF_UNAVAILABLE", error.message)
            : new BrowserHandoffAdapterError("BROWSER_HANDOFF_UNAVAILABLE", "Browser Handoff failed");
    }
    if (error.code === "TARGET_INVALID") {
        return new BrowserHandoffAdapterError("BROWSER_HANDOFF_TARGET_INVALID", "Browser Handoff requires a positive process id and an optional positive window id");
    }
    if (error.code === "INPUT_POLICY_INVALID") {
        return new BrowserHandoffAdapterError("BROWSER_HANDOFF_INPUT_POLICY_INVALID", "Browser Handoff requires an explicit bounded Human input policy");
    }
    return new BrowserHandoffAdapterError("BROWSER_HANDOFF_UNAVAILABLE", error.message);
}
//# sourceMappingURL=browser-handoff-adapter.js.map