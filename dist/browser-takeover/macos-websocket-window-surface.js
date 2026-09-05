import { spawn } from "node:child_process";
import { once } from "node:events";
import { isAbsolute } from "node:path";
import { WebSocketWindowHostRecordParser } from "./websocket-window-host-record.js";
const FRAME_WAIT_TIMEOUT_MS = 4_000;
const INPUT_ACK_TIMEOUT_MS = 4_000;
const HELPER_STOP_TIMEOUT_MS = 1_000;
const MAX_DIAGNOSTIC_BUFFER_BYTES = 8 * 1024;
class MacOSWebSocketWindowSurfaceError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "MacOSWebSocketWindowSurfaceError";
    }
}
/**
 * macOS exact-window WSS surface backed by the same reviewed local ScreenCaptureKit/AX/CGEvent
 * helper used by Window WebRTC. This class owns no WebRTC objects and never widens to display
 * capture. The helper receives only the already-authorized PID/window boundary through local env.
 */
export class MacOSWebSocketWindowSurface {
    #hostExecutable;
    #helperTtlMs;
    #secureWindow;
    #successorTransitionWindowMs;
    #onDiagnosticEvent;
    #latencyTracker;
    #active;
    #transition;
    #lastFailure = "none";
    #failure = "none";
    #framesObserved = 0;
    #inputAttempts = 0;
    #lastInputStage = "none";
    #editableRegions = [];
    #authorityBoundary = "valid";
    constructor(config) {
        if (!config.hostExecutable.trim() || !isAbsolute(config.hostExecutable)) {
            throw new Error("macOS WSS host executable must be an absolute path");
        }
        if (config.initialSecureWindowPolicy
            && config.initialSecureWindowPolicy.mode !== "macos_local_authentication") {
            throw new Error("macOS WSS initial secure-window policy is invalid");
        }
        const successorTransitionWindowMs = config.successorWindowPolicy
            ? (config.successorWindowPolicy.transitionWindowMs ?? 800)
            : undefined;
        if (config.successorWindowPolicy
            && (config.successorWindowPolicy.mode !== "same_process"
                || !Number.isSafeInteger(successorTransitionWindowMs)
                || (successorTransitionWindowMs ?? 0) < 100
                || (successorTransitionWindowMs ?? 0) > 2_000)) {
            throw new Error("macOS WSS successor policy is invalid");
        }
        if (config.initialSecureWindowPolicy && config.successorWindowPolicy) {
            throw new Error("macOS WSS initial secure-window policy cannot combine with successor lineage");
        }
        const helperTtlMs = config.helperTtlMs ?? 15 * 60_000;
        if (!Number.isSafeInteger(helperTtlMs) || helperTtlMs < 30_000 || helperTtlMs > 60 * 60_000) {
            throw new Error("macOS WSS helper ttl is invalid");
        }
        this.#hostExecutable = config.hostExecutable;
        this.#helperTtlMs = helperTtlMs;
        this.#secureWindow = config.initialSecureWindowPolicy?.mode === "macos_local_authentication";
        this.#successorTransitionWindowMs = successorTransitionWindowMs;
        this.#onDiagnosticEvent = config.onDiagnosticEvent;
        this.#latencyTracker = config.latencyTracker;
    }
    diagnosticsSnapshot() {
        return {
            lastFailure: this.#lastFailure,
            failure: this.#failure,
            framesObserved: Math.min(this.#framesObserved, 1_000_000),
            inputAttempts: Math.min(this.#inputAttempts, 1_000_000),
            lastInputStage: this.#lastInputStage,
            authorityBoundary: this.#authorityBoundary
        };
    }
    /** OS-neutral projection used by managed Browser/Window composition. */
    managedDiagnosticsSnapshot() {
        return {
            lastFailure: managedFailure(this.#lastFailure, this.#authorityBoundary),
            framesObserved: Math.min(this.#framesObserved, 1_000_000),
            lastInputStage: this.#lastInputStage === "applied" ? "applied" : "none",
            lastInputBoundaryStage: managedInputBoundary(this.#lastInputStage),
            inputAttempts: Math.min(this.#inputAttempts, 1_000_000),
            failure: managedFailure(this.#failure, this.#authorityBoundary),
            failureInputStage: this.#lastInputStage === "applied" ? "applied" : "none",
            failureInputBoundaryStage: managedInputBoundary(this.#lastInputStage),
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
            failureHelperCrashMessageClass: "none",
            authorityBoundary: this.#authorityBoundary
        };
    }
    captureFailureDisposition(_error) {
        return this.#authorityBoundary === "lost" ? "authority_lost" : "recoverable";
    }
    inputFailureDisposition(error) {
        return error instanceof MacOSWebSocketWindowSurfaceError && error.code === "AUTHORITY_LOST"
            ? "authority_lost"
            : "recoverable";
    }
    editableRegionsSnapshot() {
        return this.#editableRegions.map((region) => [...region]);
    }
    async captureExactWindow(target) {
        const previous = this.#active;
        const prepareStartedAt = performance.now();
        const active = await this.#ensure(target);
        this.#latencyTracker?.record("capture_prepare", performance.now() - prepareStartedAt);
        try {
            let frame;
            if (active !== previous && active.latest && active.sequence > 0) {
                // #ensure/#replace already waited for one exact-target JPEG. Reuse that first valid frame
                // instead of discarding it and waiting for a second helper frame during startup.
                frame = active.latest;
                this.#latencyTracker?.record("capture_frame_wait", 0);
            }
            else {
                const before = active.sequence;
                const frameWaitStartedAt = performance.now();
                frame = await this.#frameAfter(active, before);
                this.#latencyTracker?.record("capture_frame_wait", performance.now() - frameWaitStartedAt);
            }
            return {
                data: Buffer.from(frame.data),
                width: frame.width,
                height: frame.height,
                mimeType: "image/jpeg"
            };
        }
        catch (error) {
            if (this.#authorityBoundary === "lost")
                throw authorityLostError();
            if (error instanceof Error && error.message.includes("frame timed out")) {
                this.#recordFailure("frame_timeout");
            }
            throw error;
        }
    }
    tapExactWindow(target, x, y) {
        return this.#input(target, { kind: "tap", x, y });
    }
    scrollExactWindow(target, deltaY) {
        if (this.#secureWindow)
            return Promise.reject(new MacOSWebSocketWindowSurfaceError("INPUT_REJECTED", "macOS secure Window WSS does not permit scroll"));
        return this.#input(target, { kind: "scroll", deltaX: 0, deltaY });
    }
    insertExactWindowText(target, text) {
        return this.#input(target, { kind: "text", text });
    }
    pressExactWindowKey(target, key) {
        if (this.#secureWindow ? key !== "Backspace" : key !== "Backspace" && key !== "Enter") {
            return Promise.reject(new MacOSWebSocketWindowSurfaceError("INPUT_REJECTED", "macOS WSS key is unsupported"));
        }
        return this.#input(target, { kind: "key", key });
    }
    async close() {
        if (this.#transition)
            await this.#transition.catch(() => undefined);
        const active = this.#active;
        this.#active = undefined;
        if (active)
            await stopActive(active);
    }
    async #input(target, input) {
        this.#inputAttempts += 1;
        this.#lastInputStage = "requested";
        const active = await this.#ensure(target);
        active.inputChain = active.inputChain.catch(() => undefined).then(async () => {
            if (this.#authorityBoundary === "lost")
                throw authorityLostError();
            if (active.failed || this.#active !== active) {
                throw new MacOSWebSocketWindowSurfaceError("HELPER_FAILURE", "macOS WSS helper is unavailable");
            }
            if (active.pendingInputAck) {
                throw new MacOSWebSocketWindowSurfaceError("HELPER_FAILURE", "macOS WSS helper input is busy");
            }
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    if (active.pendingInputAck?.timer !== timer)
                        return;
                    active.pendingInputAck = undefined;
                    this.#lastInputStage = "rejected";
                    this.#recordFailure("input_timeout");
                    reject(new MacOSWebSocketWindowSurfaceError("HELPER_FAILURE", "macOS WSS helper input acknowledgement timed out"));
                }, INPUT_ACK_TIMEOUT_MS);
                timer.unref();
                active.pendingInputAck = { resolve, reject, timer };
                active.child.stdin.write(`${JSON.stringify(input)}\n`, (error) => {
                    if (!error)
                        return;
                    if (active.pendingInputAck?.timer === timer) {
                        clearTimeout(timer);
                        active.pendingInputAck = undefined;
                    }
                    reject(new MacOSWebSocketWindowSurfaceError("HELPER_FAILURE", "macOS WSS helper input write failed"));
                });
                this.#lastInputStage = "command_sent";
            });
        });
        return active.inputChain;
    }
    async #ensure(target) {
        validateTarget(target, this.#secureWindow);
        if (this.#authorityBoundary === "lost")
            throw authorityLostError();
        const active = this.#active;
        if (active && !active.failed && sameTarget(active.target, target))
            return active;
        if (this.#transition) {
            await this.#transition;
            return this.#ensure(target);
        }
        this.#transition = this.#replace(target).finally(() => { this.#transition = undefined; });
        await this.#transition;
        const ready = this.#active;
        if (!ready || ready.failed || !sameTarget(ready.target, target)) {
            throw new MacOSWebSocketWindowSurfaceError("HELPER_FAILURE", "macOS WSS helper is unavailable");
        }
        return ready;
    }
    async #replace(target) {
        const previous = this.#active;
        this.#active = undefined;
        if (previous)
            await stopActive(previous);
        this.#editableRegions = [];
        const env = {
            LANG: "C.UTF-8",
            LC_ALL: "C.UTF-8",
            TAKEOVER_WEBRTC_TARGET_PID: String(target.processId),
            TAKEOVER_WEBRTC_EXPIRES_AT_UNIX_MS: String(Date.now() + this.#helperTtlMs),
            TAKEOVER_WEBRTC_FRAME_FORMAT: "jpeg",
            TAKEOVER_WEBRTC_MEDIA_PROFILE: "window_text"
        };
        if (this.#secureWindow) {
            env.TAKEOVER_WEBRTC_INITIAL_SECURE_WINDOW = "macos_local_authentication";
        }
        else {
            env.TAKEOVER_WEBRTC_TARGET_WINDOW_ID = String(target.windowId);
            if (this.#successorTransitionWindowMs !== undefined) {
                env.TAKEOVER_WEBRTC_WINDOW_LINEAGE = "same_process_successor";
                env.TAKEOVER_WEBRTC_WINDOW_LINEAGE_TRANSITION_MS = String(this.#successorTransitionWindowMs);
            }
        }
        const child = spawn(this.#hostExecutable, [], { env, stdio: ["pipe", "pipe", "pipe"] });
        const state = {
            target: { ...target },
            child,
            sequence: 0,
            failed: false,
            stopping: false,
            frameWaiters: [],
            stderrBuffer: "",
            pendingInputAck: undefined,
            inputChain: Promise.resolve()
        };
        const parser = new WebSocketWindowHostRecordParser((frame) => {
            if (state.failed)
                return;
            state.latest = frame;
            state.sequence += 1;
            this.#framesObserved += 1;
            const ready = state.frameWaiters.filter((waiter) => state.sequence > waiter.afterSequence);
            state.frameWaiters = state.frameWaiters.filter((waiter) => state.sequence <= waiter.afterSequence);
            for (const waiter of ready) {
                clearTimeout(waiter.timer);
                waiter.resolve(frame);
            }
        }, (editable) => this.#onDiagnosticEvent?.(editable ? "host_focus_editable" : "host_focus_not_editable"));
        child.stdout.on("data", (chunk) => {
            try {
                parser.push(chunk);
            }
            catch {
                this.#recordFailure("frame_protocol");
                if (this.#successorTransitionWindowMs !== undefined && !state.stopping)
                    this.#noteAuthorityLoss();
                failActive(state, "macOS WSS exact-window helper frame protocol failed");
            }
        });
        child.stderr.on("data", (chunk) => this.#consumeDiagnostics(state, chunk));
        child.once("error", () => {
            this.#recordFailure("helper_error");
            if (this.#successorTransitionWindowMs !== undefined && !state.stopping)
                this.#noteAuthorityLoss();
            failActive(state, "macOS WSS exact-window helper failed");
        });
        child.once("close", () => {
            if (!state.failed)
                this.#recordFailure("helper_closed");
            if (this.#successorTransitionWindowMs !== undefined && !state.stopping)
                this.#noteAuthorityLoss();
            failActive(state, "macOS WSS exact-window helper closed");
        });
        this.#active = state;
        await this.#frameAfter(state, 0);
    }
    #consumeDiagnostics(state, chunk) {
        if (state.failed)
            return;
        state.stderrBuffer += chunk.toString("utf8");
        if (Buffer.byteLength(state.stderrBuffer, "utf8") > MAX_DIAGNOSTIC_BUFFER_BYTES) {
            this.#recordFailure("diagnostics_bounds");
            if (this.#successorTransitionWindowMs !== undefined && !state.stopping)
                this.#noteAuthorityLoss();
            failActive(state, "macOS WSS helper diagnostics exceeded bounds");
            return;
        }
        for (;;) {
            const newline = state.stderrBuffer.indexOf("\n");
            if (newline < 0)
                return;
            const line = state.stderrBuffer.slice(0, newline);
            state.stderrBuffer = state.stderrBuffer.slice(newline + 1);
            const regions = parseEditableRegions(line);
            if (regions) {
                this.#editableRegions = regions;
                this.#onDiagnosticEvent?.(regions.length > 0
                    ? "host_editable_regions_available"
                    : "host_editable_regions_empty");
                continue;
            }
            const successorStage = this.#successorTransitionWindowMs === undefined
                ? undefined
                : parseSuccessorStage(line);
            if (successorStage) {
                this.#onDiagnosticEvent?.(`host_successor_${successorStage}`);
                if (successorStage === "ambiguous" || successorStage === "unsupported" || successorStage === "failure") {
                    this.#noteAuthorityLoss();
                    settleInput(state, false, authorityLostError());
                }
                continue;
            }
            if (line === "MCP_HANDOFF_DIAGNOSTIC input_stage=applied") {
                this.#lastInputStage = "applied";
                settleInput(state, true);
                continue;
            }
            if (line === "MCP_HANDOFF_DIAGNOSTIC input_stage=authority_lost"
                || line === "MCP_HANDOFF_DIAGNOSTIC capture_stage=authority_lost"
                || line === "MCP_HANDOFF_DIAGNOSTIC host_exit_reason=window_resolution") {
                this.#noteAuthorityLoss();
                settleInput(state, false, authorityLostError());
                continue;
            }
            if (line === "MCP_HANDOFF_DIAGNOSTIC input_stage=rejected"
                || line === "MCP_HANDOFF_DIAGNOSTIC input_stage=activation_failed") {
                this.#lastInputStage = "rejected";
                this.#recordFailure("input_rejected");
                settleInput(state, false, new MacOSWebSocketWindowSurfaceError("INPUT_REJECTED", "macOS WSS exact-window input was rejected"));
            }
        }
    }
    #frameAfter(active, afterSequence) {
        if (active.failed || this.#active !== active) {
            return Promise.reject(new MacOSWebSocketWindowSurfaceError("HELPER_FAILURE", "macOS WSS helper is unavailable"));
        }
        if (active.latest && active.sequence > afterSequence)
            return Promise.resolve(active.latest);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                active.frameWaiters = active.frameWaiters.filter((waiter) => waiter.timer !== timer);
                reject(new Error("macOS WSS exact-window frame timed out"));
            }, FRAME_WAIT_TIMEOUT_MS);
            timer.unref();
            active.frameWaiters.push({ afterSequence, resolve, reject, timer });
        });
    }
    #recordFailure(failure) {
        this.#lastFailure = failure;
        if (failure === "input_timeout" || failure === "input_failure" || failure === "input_rejected") {
            this.#onDiagnosticEvent?.("input_dispatch_failure");
        }
        if (this.#failure === "none")
            this.#failure = failure;
    }
    #noteAuthorityLoss() {
        if (this.#authorityBoundary === "lost")
            return;
        this.#authorityBoundary = "lost";
        this.#recordFailure("authority_lost");
        this.#onDiagnosticEvent?.("authority_boundary_lost");
    }
}
function validateTarget(target, secureWindow) {
    if (!Number.isSafeInteger(target.processId) || target.processId <= 0) {
        throw new Error("macOS WSS exact-window target process is invalid");
    }
    if (secureWindow) {
        if (target.windowId !== undefined) {
            throw new Error("macOS LocalAuthentication WSS resolves the exact secure window from PID only");
        }
        return;
    }
    if (!Number.isSafeInteger(target.windowId) || (target.windowId ?? 0) <= 0) {
        throw new Error("macOS WSS exact-window target window is invalid");
    }
}
function sameTarget(left, right) {
    return left.processId === right.processId && left.windowId === right.windowId;
}
function settleInput(state, ok, error) {
    const pending = state.pendingInputAck;
    if (!pending)
        return;
    state.pendingInputAck = undefined;
    clearTimeout(pending.timer);
    if (ok)
        pending.resolve();
    else
        pending.reject(error ?? new Error("macOS WSS input failed"));
}
function parseEditableRegions(line) {
    const prefix = "MCP_HANDOFF_CONTROL editable_regions=";
    if (!line.startsWith(prefix))
        return undefined;
    const raw = line.slice(prefix.length);
    if (!raw)
        return [];
    const regions = [];
    for (const item of raw.split(";").slice(0, 32)) {
        const values = item.split(",").map(Number);
        if (values.length !== 4 || values.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 10_000)) {
            return [];
        }
        regions.push(values);
    }
    return regions;
}
function parseSuccessorStage(line) {
    const prefix = "MCP_HANDOFF_DIAGNOSTIC successor_stage=";
    if (!line.startsWith(prefix))
        return undefined;
    const stage = line.slice(prefix.length);
    return stage === "probe_started" || stage === "admitted" || stage === "returned" || stage === "none"
        || stage === "ambiguous" || stage === "unsupported" || stage === "failure"
        ? stage
        : undefined;
}
function managedFailure(failure, authorityBoundary) {
    if (authorityBoundary === "lost" || failure === "authority_lost")
        return "revalidation_failure";
    if (failure === "input_rejected")
        return "input_failure";
    return failure;
}
function managedInputBoundary(stage) {
    if (stage === "requested")
        return "requested";
    if (stage === "command_sent")
        return "command_sent";
    if (stage === "applied")
        return "acknowledged";
    if (stage === "rejected")
        return "command_sent";
    return "none";
}
function authorityLostError() {
    return new MacOSWebSocketWindowSurfaceError("AUTHORITY_LOST", "macOS WSS exact-window authority was lost");
}
function failActive(active, message) {
    if (active.failed)
        return;
    active.failed = true;
    const error = new MacOSWebSocketWindowSurfaceError("HELPER_FAILURE", message);
    for (const waiter of active.frameWaiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
    }
    settleInput(active, false, error);
    if (active.child.exitCode === null && active.child.signalCode === null)
        active.child.kill("SIGTERM");
}
async function stopActive(active) {
    active.stopping = true;
    if (active.pendingInputAck)
        settleInput(active, false, new Error("macOS WSS helper stopped"));
    if (active.child.exitCode !== null || active.child.signalCode !== null)
        return;
    try {
        active.child.stdin.on("error", () => undefined);
        active.child.stdin.end('{"kind":"stop"}\n');
    }
    catch { }
    const closed = await Promise.race([
        once(active.child, "close").then(() => true, () => true),
        new Promise((resolve) => setTimeout(() => resolve(false), HELPER_STOP_TIMEOUT_MS))
    ]);
    if (!closed && active.child.exitCode === null && active.child.signalCode === null)
        active.child.kill("SIGTERM");
}
//# sourceMappingURL=macos-websocket-window-surface.js.map