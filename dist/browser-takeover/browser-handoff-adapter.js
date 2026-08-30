import { emptyManagedOperatorDiagnosticsSnapshot } from "./managed-operator-diagnostics.js";
import { webRtcOperatorDiagnosticsSnapshot } from "./webrtc-diagnostics.js";
import { emptyWebSocketLatencySnapshot } from "./websocket-latency.js";
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
 * Direct WebRTC remains unchanged by default. An explicit transport policy may select one attempt
 * or any reviewed order of direct WebRTC, WSS, and relay-capable WebRTC. Handoff fences the active
 * generation before every transition and the consumer keeps one Browser lifecycle API.
 */
export class BrowserHandoffAdapter {
    #core;
    constructor(config) {
        try {
            this.#core = config.managedFallback || config.transportPolicy
                ? new ManagedWindowHandoffRuntime({
                    takeover: config.takeover,
                    runtime: config.runtime,
                    ...(config.managedFallback ? { managedFallback: config.managedFallback } : {}),
                    ...(config.transportPolicy ? { transportPolicy: config.transportPolicy } : {}),
                    ...(config.onManagedOperatorDiagnosticEvent
                        ? { onManagedOperatorDiagnosticEvent: config.onManagedOperatorDiagnosticEvent }
                        : {}),
                    ...(config.onComplete ? { onComplete: config.onComplete } : {}),
                    ...(config.onAuthorityReleased ? { onAuthorityReleased: config.onAuthorityReleased } : {})
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
    /** Stable content-free managed transport diagnostics; empty when managed fallback is disabled. */
    managedOperatorDiagnosticsSnapshot() {
        return this.#core instanceof ManagedWindowHandoffRuntime
            ? this.#core.managedOperatorDiagnosticsSnapshot("browser_handoff")
            : emptyManagedOperatorDiagnosticsSnapshot("browser_handoff");
    }
    /** @internal Content-free managed WSS surface diagnostics for physical acceptance. */
    managedSurfaceDiagnosticsSnapshot() {
        return this.#core instanceof ManagedWindowHandoffRuntime
            ? this.#core.managedSurfaceDiagnosticsSnapshot()
            : {
                lastFailure: "none",
                framesObserved: 0,
                lastInputStage: "none",
                lastInputBoundaryStage: "none",
                inputAttempts: 0,
                failure: "none",
                failureInputStage: "none",
                failureInputBoundaryStage: "none",
                lastInputFailureDetail: "none",
                failureInputFailureDetail: "none",
                lastHelperStopReason: "none",
                failureHelperStopReason: "none",
                lastHelperCrashReason: "none",
                failureHelperCrashReason: "none",
                lastHelperExitKind: "none",
                failureHelperExitKind: "none",
                lastHelperCrashClass: "none",
                failureHelperCrashClass: "none",
                lastHelperCrashOrigin: "none",
                failureHelperCrashOrigin: "none",
                lastHelperCrashErrorKind: "none",
                failureHelperCrashErrorKind: "none",
                lastHelperCrashMessageClass: "none",
                failureHelperCrashMessageClass: "none"
            };
    }
    /** @internal Content-free managed WSS ingress diagnostics for physical acceptance. */
    managedWebSocketDiagnosticsSnapshot() {
        return this.#core instanceof ManagedWindowHandoffRuntime
            ? this.#core.managedWebSocketDiagnosticsSnapshot()
            : {
                disconnectKind: "none",
                channelState: "none",
                sentFrames: 0,
                droppedFrames: 0,
                lastFailure: "none",
                lastInputStage: "none",
                failureDisconnectKind: "none",
                failureChannelState: "none",
                failureCode: "none",
                failureInputStage: "none"
            };
    }
    /** @internal Separate WSS performance evidence; never interpreted as WebRTC latency. */
    managedWebSocketLatencySnapshot() {
        return this.#core instanceof ManagedWindowHandoffRuntime
            ? this.#core.managedWebSocketLatencySnapshot()
            : emptyWebSocketLatencySnapshot();
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