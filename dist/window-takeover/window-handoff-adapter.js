import { emptyManagedOperatorDiagnosticsSnapshot } from "../browser-takeover/managed-operator-diagnostics.js";
import { webRtcOperatorDiagnosticsSnapshot } from "../browser-takeover/webrtc-diagnostics.js";
import { ManagedWindowHandoffRuntime } from "../browser-takeover/managed-handoff-runtime.js";
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
 * First-class bounded OS-window Handoff composition for MCP consumers.
 *
 * Direct WebRTC remains the default. When managed fallback is configured, Handoff owns strict
 * direct WebRTC -> WSS -> optional TURN transitions and still never widens to display capture.
 */
export class WindowHandoffAdapter {
    #core;
    constructor(config) {
        try {
            this.#core = config.managedFallback
                ? new ManagedWindowHandoffRuntime({
                    takeover: config.takeover,
                    runtime: config.runtime,
                    managedFallback: config.managedFallback,
                    mediaProfile: "window_text",
                    ...(config.successorWindowPolicy ? { successorWindowPolicy: config.successorWindowPolicy } : {}),
                    ...(config.initialSecureWindowPolicy ? { initialSecureWindowPolicy: config.initialSecureWindowPolicy } : {}),
                    ...(config.onComplete ? { onComplete: config.onComplete } : {})
                })
                : new WindowHandoffCore({ ...config, mediaProfile: "window_text" });
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
    /** Fence a session only after the consumer independently verifies the Human action succeeded. */
    async completeAfterVerification(intervention) {
        return this.#core.completeAfterVerification(intervention);
    }
    /** Synchronously invalidate a locator that was cancelled before any Human generation was claimed. */
    revokeUnclaimed(interventionId) { this.#core.revokeUnclaimed(interventionId); }
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
            ? this.#core.operatorDiagnosticsSnapshot("window_handoff")
            : webRtcOperatorDiagnosticsSnapshot("window_handoff", this.#core.diagnosticsSnapshot());
    }
    /** Stable content-free managed transport diagnostics; empty when managed fallback is disabled. */
    managedOperatorDiagnosticsSnapshot() {
        return this.#core instanceof ManagedWindowHandoffRuntime
            ? this.#core.managedOperatorDiagnosticsSnapshot("window_handoff")
            : emptyManagedOperatorDiagnosticsSnapshot("window_handoff");
    }
    latencySnapshot() { return this.#core.latencySnapshot(); }
}
function translateError(error) {
    if (!(error instanceof WindowHandoffCoreError)) {
        return error instanceof Error
            ? new WindowHandoffAdapterError("WINDOW_HANDOFF_UNAVAILABLE", error.message)
            : new WindowHandoffAdapterError("WINDOW_HANDOFF_UNAVAILABLE", "Window Handoff failed");
    }
    const code = error.code === "TARGET_INVALID"
        ? "WINDOW_HANDOFF_TARGET_INVALID"
        : error.code === "INPUT_POLICY_INVALID"
            ? "WINDOW_HANDOFF_INPUT_POLICY_INVALID"
            : error.code === "SUCCESSOR_POLICY_INVALID"
                ? "WINDOW_HANDOFF_SUCCESSOR_POLICY_INVALID"
                : error.code === "INITIAL_SECURE_WINDOW_POLICY_INVALID"
                    ? "WINDOW_HANDOFF_INITIAL_SECURE_WINDOW_POLICY_INVALID"
                    : "WINDOW_HANDOFF_UNAVAILABLE";
    return new WindowHandoffAdapterError(code, error.message);
}
//# sourceMappingURL=window-handoff-adapter.js.map