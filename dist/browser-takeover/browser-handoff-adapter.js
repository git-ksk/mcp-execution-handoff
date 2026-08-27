import { webRtcOperatorDiagnosticsSnapshot } from "./webrtc-diagnostics.js";
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
 * First-class Browser WebRTC Handoff composition for standalone MCP consumers.
 *
 * Browser/profile/authentication semantics remain consumer-owned. This facade reuses the same
 * bounded exact-window WebRTC/session core as `WindowHandoffAdapter`, while preserving the existing
 * Browser public API and its explicit no-HTTP-frame-downgrade contract.
 */
export class BrowserHandoffAdapter {
    #core;
    constructor(config) {
        this.#core = new WindowHandoffCore(config);
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
    handle(request, boundPrincipal) { return this.#core.handle(request, boundPrincipal); }
    diagnosticsSnapshot() { return this.#core.diagnosticsSnapshot(); }
    operatorDiagnosticsSnapshot() { return webRtcOperatorDiagnosticsSnapshot("browser_handoff", this.#core.diagnosticsSnapshot()); }
    latencySnapshot() { return this.#core.latencySnapshot(); }
}
function translateError(error) {
    if (!(error instanceof WindowHandoffCoreError))
        return error instanceof Error ? error : new Error("Browser Handoff failed");
    if (error.code === "TARGET_INVALID") {
        return new BrowserHandoffAdapterError("BROWSER_HANDOFF_TARGET_INVALID", "Browser Handoff requires a positive process id and an optional positive window id");
    }
    if (error.code === "INPUT_POLICY_INVALID") {
        return new BrowserHandoffAdapterError("BROWSER_HANDOFF_INPUT_POLICY_INVALID", "Browser Handoff requires an explicit bounded Human input policy");
    }
    return new BrowserHandoffAdapterError("BROWSER_HANDOFF_UNAVAILABLE", "Browser WebRTC Handoff is unavailable");
}
//# sourceMappingURL=browser-handoff-adapter.js.map