import { WindowHandoffCore, WindowHandoffCoreError } from "./window-handoff-core.js";
export class WindowHandoffAdapterError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "WindowHandoffAdapterError";
    }
}
/**
 * First-class bounded OS-window WebRTC Handoff composition for MCP consumers.
 *
 * Consumers own application/domain semantics, process lifecycle, intervention policy and fresh
 * verification. Handoff owns locator/session lifecycle, exact process/window capture/input,
 * WebRTC/TURN/reconnect behavior, revoke and privacy-bounded transport diagnostics.
 *
 * This adapter always requires an exact process boundary and never exposes display/desktop-wide
 * capture as a fallback.
 */
export class WindowHandoffAdapter {
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
    latencySnapshot() { return this.#core.latencySnapshot(); }
}
function translateError(error) {
    if (!(error instanceof WindowHandoffCoreError))
        return error instanceof Error ? error : new Error("Window Handoff failed");
    const code = error.code === "TARGET_INVALID"
        ? "WINDOW_HANDOFF_TARGET_INVALID"
        : error.code === "INPUT_POLICY_INVALID"
            ? "WINDOW_HANDOFF_INPUT_POLICY_INVALID"
            : "WINDOW_HANDOFF_UNAVAILABLE";
    return new WindowHandoffAdapterError(code, error.message);
}
//# sourceMappingURL=window-handoff-adapter.js.map