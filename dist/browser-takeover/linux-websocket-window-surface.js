import { spawn } from "node:child_process";
import { once } from "node:events";
import { isAbsolute } from "node:path";
import { parseWindowGeometry, parseWindowIds } from "../browser-takeover/linux-webrtc-host-cli.js";
const MAX_HOST_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_DIAGNOSTIC_BUFFER_BYTES = 8 * 1024;
const FRAME_WAIT_TIMEOUT_MS = 4_000;
const CAPTURE_RECOVERY_ATTEMPTS = 2;
const CAPTURE_RECOVERY_DELAY_MS = 120;
const INPUT_ACK_TIMEOUT_MS = 4_000;
const HELPER_STOP_TIMEOUT_MS = 1_000;
const QUERY_TIMEOUT_MS = 2_000;
/** Parses private JPEG records while accepting the helper's bounded editable-focus control record. */
export class LinuxWebSocketHostRecordParser {
    onFrame;
    #pending = Buffer.alloc(0);
    constructor(onFrame) {
        this.onFrame = onFrame;
    }
    push(chunk) {
        if (chunk.byteLength === 0)
            return;
        this.#pending = this.#pending.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([this.#pending, chunk]);
        if (this.#pending.byteLength > MAX_HOST_RECORD_BYTES + 5) {
            throw new Error("Linux WSS host record buffer exceeded bounds");
        }
        for (;;) {
            if (this.#pending.byteLength < 5)
                return;
            const type = this.#pending[0];
            const length = this.#pending.readUInt32BE(1);
            if (type !== 2 || length < 1 || length > MAX_HOST_RECORD_BYTES) {
                throw new Error("Linux WSS host emitted an invalid record");
            }
            if (this.#pending.byteLength < 5 + length)
                return;
            const payload = this.#pending.subarray(5, 5 + length);
            this.#pending = this.#pending.subarray(5 + length);
            if (length === 1) {
                if (payload[0] !== 0 && payload[0] !== 1) {
                    throw new Error("Linux WSS host emitted an invalid editable-focus record");
                }
                continue;
            }
            if (length < 8)
                throw new Error("Linux WSS host emitted an invalid record");
            const width = payload.readUInt16BE(0);
            const height = payload.readUInt16BE(2);
            const data = payload.subarray(4);
            if (width < 1
                || height < 1
                || data.byteLength < 4
                || data[0] !== 0xff
                || data[1] !== 0xd8
                || data[data.byteLength - 2] !== 0xff
                || data[data.byteLength - 1] !== 0xd9) {
                throw new Error("Linux WSS host emitted an invalid JPEG frame");
            }
            this.onFrame({ data: Buffer.from(data), width, height });
        }
    }
}
/**
 * Private Linux physical-Acceptance surface for the #40 WSS experiment.
 *
 * It deliberately reuses the existing normal-browser exact-window helper. The helper still owns
 * X11 target resolution, capture and Human input. This adapter selects its JPEG-only stdout mode,
 * keeps the process/window tuple server-side, revalidates that exact tuple before every returned
 * frame/input, and never exposes helper transport details to Browser/Window consumers.
 */
export class ExperimentalLinuxWebSocketWindowSurface {
    #hostScript;
    #displayName;
    #xdotoolExecutable;
    #helperTtlMs;
    #active;
    #transition;
    #lastFailure = "none";
    #failure = "none";
    #framesObserved = 0;
    #lastInputStage = "none";
    #lastInputBoundaryStage = "none";
    #failureInputStage = "none";
    #failureInputBoundaryStage = "none";
    #lastInputFailureDetail = "none";
    #failureInputFailureDetail = "none";
    #lastHelperStopReason = "none";
    #failureHelperStopReason = "none";
    #lastHelperCrashReason = "none";
    #failureHelperCrashReason = "none";
    #lastHelperExitKind = "none";
    #failureHelperExitKind = "none";
    #lastHelperCrashClass = "none";
    #failureHelperCrashClass = "none";
    #lastHelperCrashOrigin = "none";
    #failureHelperCrashOrigin = "none";
    #lastHelperCrashErrorKind = "none";
    #failureHelperCrashErrorKind = "none";
    #lastHelperCrashMessageClass = "none";
    #failureHelperCrashMessageClass = "none";
    #inputAttempts = 0;
    constructor(config) {
        if (!config.hostScript.trim() || !isAbsolute(config.hostScript)) {
            throw new Error("Linux WSS host script must be an absolute path");
        }
        if (!/^:\d+(?:\.\d+)?$/.test(config.displayName)) {
            throw new Error("Linux WSS display name must be a local X11 display such as :99");
        }
        const xdotoolExecutable = config.xdotoolExecutable ?? "/usr/bin/xdotool";
        if (!isAbsolute(xdotoolExecutable))
            throw new Error("Linux WSS xdotool executable must be absolute");
        const helperTtlMs = config.helperTtlMs ?? 15 * 60_000;
        if (!Number.isSafeInteger(helperTtlMs) || helperTtlMs < 30_000 || helperTtlMs > 60 * 60_000) {
            throw new Error("Linux WSS helper ttl is invalid");
        }
        this.#hostScript = config.hostScript;
        this.#displayName = config.displayName;
        this.#xdotoolExecutable = xdotoolExecutable;
        this.#helperTtlMs = helperTtlMs;
    }
    diagnosticsSnapshot() {
        return {
            lastFailure: this.#lastFailure,
            framesObserved: Math.min(this.#framesObserved, 1_000_000),
            lastInputStage: this.#lastInputStage,
            lastInputBoundaryStage: this.#lastInputBoundaryStage,
            inputAttempts: Math.min(this.#inputAttempts, 1_000_000),
            failure: this.#failure,
            failureInputStage: this.#failureInputStage,
            failureInputBoundaryStage: this.#failureInputBoundaryStage,
            lastInputFailureDetail: this.#lastInputFailureDetail,
            failureInputFailureDetail: this.#failureInputFailureDetail,
            lastHelperStopReason: this.#lastHelperStopReason,
            failureHelperStopReason: this.#failureHelperStopReason,
            lastHelperCrashReason: this.#lastHelperCrashReason,
            failureHelperCrashReason: this.#failureHelperCrashReason,
            lastHelperExitKind: this.#lastHelperExitKind,
            failureHelperExitKind: this.#failureHelperExitKind,
            lastHelperCrashClass: this.#lastHelperCrashClass,
            failureHelperCrashClass: this.#failureHelperCrashClass,
            lastHelperCrashOrigin: this.#lastHelperCrashOrigin,
            failureHelperCrashOrigin: this.#failureHelperCrashOrigin,
            lastHelperCrashErrorKind: this.#lastHelperCrashErrorKind,
            failureHelperCrashErrorKind: this.#failureHelperCrashErrorKind,
            lastHelperCrashMessageClass: this.#lastHelperCrashMessageClass,
            failureHelperCrashMessageClass: this.#failureHelperCrashMessageClass
        };
    }
    captureFailureDisposition(error) {
        return isExactWindowBoundaryError(error) ? "authority_lost" : "recoverable";
    }
    async captureExactWindow(target) {
        let lastError;
        for (let attempt = 0; attempt < CAPTURE_RECOVERY_ATTEMPTS; attempt += 1) {
            let active;
            try {
                active = await this.#ensure(target);
            }
            catch (error) {
                if (isExactWindowBoundaryError(error) || attempt + 1 >= CAPTURE_RECOVERY_ATTEMPTS)
                    throw error;
                lastError = error;
                await delay(CAPTURE_RECOVERY_DELAY_MS);
                continue;
            }
            const before = active.sequence;
            try {
                await this.#revalidate(target);
            }
            catch (error) {
                this.#recordFailure("revalidation_failure");
                throw error;
            }
            try {
                const frame = await this.#frameAfter(active, before);
                return {
                    data: Buffer.from(frame.data),
                    width: frame.width,
                    height: frame.height,
                    mimeType: "image/jpeg"
                };
            }
            catch (error) {
                lastError = error;
                if (isExactWindowBoundaryError(error))
                    throw error;
                if (error instanceof Error && error.message.includes("frame timed out")) {
                    this.#recordFailure("frame_timeout");
                }
                if (attempt + 1 >= CAPTURE_RECOVERY_ATTEMPTS)
                    throw error;
                // Keep the authority boundary exact: fence only the failed helper process, then recreate it
                // for the same PID/window after the next mandatory ownership revalidation.
                failActive(active, "Linux WSS exact-window helper capture stalled");
                await delay(CAPTURE_RECOVERY_DELAY_MS);
            }
        }
        throw lastError instanceof Error ? lastError : new Error("Linux WSS exact-window capture failed");
    }
    tapExactWindow(target, x, y) {
        return this.#input(target, { kind: "tap", x, y });
    }
    scrollExactWindow(target, deltaY) {
        return this.#input(target, { kind: "scroll", deltaX: 0, deltaY });
    }
    insertExactWindowText(target, text) {
        return this.#input(target, { kind: "text", text });
    }
    pressExactWindowKey(target, key) {
        if (key !== "Backspace" && key !== "Enter")
            return Promise.reject(new Error("Linux WSS key is unsupported"));
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
        this.#lastInputStage = "none";
        this.#lastInputFailureDetail = "none";
        this.#lastInputBoundaryStage = "requested";
        const active = await this.#ensure(target);
        this.#lastInputBoundaryStage = "helper_ready";
        active.inputChain = active.inputChain.then(async () => {
            if (active.failed || this.#active !== active)
                throw new Error("Linux WSS exact-window helper is unavailable");
            try {
                await this.#revalidate(target);
                this.#lastInputBoundaryStage = "revalidation_ready";
            }
            catch (error) {
                this.#recordFailure("input_revalidation_failure");
                throw error;
            }
            if (active.pendingInputAck)
                throw new Error("Linux WSS exact-window helper input is busy");
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    if (active.pendingInputAck?.timer !== timer)
                        return;
                    active.pendingInputAck = undefined;
                    this.#recordFailure("input_timeout");
                    reject(new Error("Linux WSS exact-window helper input acknowledgement timed out"));
                    failActive(active, "Linux WSS exact-window helper input acknowledgement timed out");
                }, INPUT_ACK_TIMEOUT_MS);
                active.pendingInputAck = {
                    resolve: () => {
                        this.#lastInputBoundaryStage = "acknowledged";
                        resolve();
                    },
                    reject,
                    timer
                };
                const line = `${JSON.stringify(input)}\n`;
                active.child.stdin.write(line);
                this.#lastInputBoundaryStage = "command_sent";
            });
        });
        return active.inputChain;
    }
    async #ensure(target) {
        validateExactTarget(target);
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
            throw new Error("Linux WSS exact-window helper is unavailable");
        }
        return ready;
    }
    async #replace(target) {
        const previous = this.#active;
        this.#active = undefined;
        if (previous)
            await stopActive(previous);
        await this.#revalidate(target);
        const child = spawn(process.execPath, [this.#hostScript], {
            env: {
                LANG: "C.UTF-8",
                LC_ALL: "C.UTF-8",
                TAKEOVER_WEBRTC_TARGET_PID: String(target.processId),
                TAKEOVER_WEBRTC_TARGET_WINDOW_ID: String(target.windowId),
                TAKEOVER_WEBRTC_EXPIRES_AT_UNIX_MS: String(Date.now() + this.#helperTtlMs),
                TAKEOVER_WEBRTC_DISPLAY_NAME: this.#displayName,
                TAKEOVER_WEBRTC_FRAME_FORMAT: "jpeg"
            },
            stdio: ["pipe", "pipe", "pipe"]
        });
        const state = {
            target: { ...target },
            child,
            sequence: 0,
            failed: false,
            frameWaiters: [],
            stderrBuffer: "",
            pendingInputAck: undefined,
            inputChain: Promise.resolve()
        };
        const parser = new LinuxWebSocketHostRecordParser((frame) => {
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
        });
        child.stdout.on("data", (chunk) => {
            try {
                parser.push(chunk);
            }
            catch {
                this.#recordFailure("frame_protocol");
                failActive(state, "Linux WSS exact-window helper frame protocol failed");
            }
        });
        child.stderr.on("data", (chunk) => consumeDiagnostics(state, chunk, (stage) => {
            const category = captureFailureCategory(stage);
            if (category)
                this.#recordFailure(category);
            else if (stage === "input_failure")
                this.#recordFailure("input_failure");
            const inputStage = boundedInputStage(stage);
            if (inputStage)
                this.#lastInputStage = inputStage;
            const inputFailureDetail = boundedInputFailureDetail(stage);
            if (inputFailureDetail)
                this.#lastInputFailureDetail = inputFailureDetail;
            const helperStopReason = boundedHelperStopReason(stage);
            if (helperStopReason)
                this.#lastHelperStopReason = helperStopReason;
            const helperCrashReason = boundedHelperCrashReason(stage);
            if (helperCrashReason)
                this.#lastHelperCrashReason = helperCrashReason;
            const helperCrashClass = boundedHelperCrashClass(stage);
            if (helperCrashClass)
                this.#lastHelperCrashClass = helperCrashClass;
            const helperCrashOrigin = boundedHelperCrashOrigin(stage);
            if (helperCrashOrigin)
                this.#lastHelperCrashOrigin = helperCrashOrigin;
            const helperCrashErrorKind = boundedHelperCrashErrorKind(stage);
            if (helperCrashErrorKind)
                this.#lastHelperCrashErrorKind = helperCrashErrorKind;
            const helperCrashMessageClass = boundedHelperCrashMessageClass(stage);
            if (helperCrashMessageClass)
                this.#lastHelperCrashMessageClass = helperCrashMessageClass;
        }));
        child.once("error", () => {
            if (this.#lastFailure === "none")
                this.#recordFailure("helper_error");
            failActive(state, "Linux WSS exact-window helper failed");
        });
        child.once("close", (code, signal) => {
            this.#lastHelperExitKind = signal !== null ? "signal" : code === 0 ? "clean" : "nonzero";
            if (this.#lastFailure === "none")
                this.#recordFailure("helper_closed");
            failActive(state, "Linux WSS exact-window helper closed");
        });
        this.#active = state;
        await this.#frameAfter(state, 0);
    }
    async #frameAfter(active, afterSequence) {
        if (active.failed || this.#active !== active)
            throw new Error("Linux WSS exact-window helper is unavailable");
        if (active.latest && active.sequence > afterSequence)
            return active.latest;
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                active.frameWaiters = active.frameWaiters.filter((waiter) => waiter.timer !== timer);
                reject(new Error("Linux WSS exact-window frame timed out"));
            }, FRAME_WAIT_TIMEOUT_MS);
            active.frameWaiters.push({ afterSequence, resolve, reject, timer });
        });
    }
    #recordFailure(failure) {
        this.#lastFailure = failure;
        if (this.#failure !== "none")
            return;
        this.#failure = failure;
        this.#failureInputStage = this.#lastInputStage;
        this.#failureInputBoundaryStage = this.#lastInputBoundaryStage;
        this.#failureInputFailureDetail = this.#lastInputFailureDetail;
        this.#failureHelperStopReason = this.#lastHelperStopReason;
        this.#failureHelperCrashReason = this.#lastHelperCrashReason;
        this.#failureHelperExitKind = this.#lastHelperExitKind;
        this.#failureHelperCrashClass = this.#lastHelperCrashClass;
        this.#failureHelperCrashOrigin = this.#lastHelperCrashOrigin;
        this.#failureHelperCrashErrorKind = this.#lastHelperCrashErrorKind;
        this.#failureHelperCrashMessageClass = this.#lastHelperCrashMessageClass;
    }
    async #revalidate(target) {
        validateExactTarget(target);
        try {
            process.kill(target.processId, 0);
        }
        catch {
            throw new Error("Linux WSS target process is unavailable");
        }
        const env = { DISPLAY: this.#displayName, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
        const visible = parseWindowIds(await runBounded(this.#xdotoolExecutable, [
            "search", "--onlyvisible", "--pid", String(target.processId)
        ], env).catch(() => ""));
        if (!visible.includes(target.windowId))
            throw new Error("Linux WSS target window is no longer visible");
        const owner = Number((await runBounded(this.#xdotoolExecutable, [
            "getwindowpid", String(target.windowId)
        ], env).catch(() => "")).trim());
        if (owner !== target.processId)
            throw new Error("Linux WSS target window ownership changed");
        const geometry = parseWindowGeometry(await runBounded(this.#xdotoolExecutable, [
            "getwindowgeometry", "--shell", String(target.windowId)
        ], env).catch(() => ""), target.windowId);
        if (!geometry)
            throw new Error("Linux WSS target window geometry is unavailable");
    }
}
function isExactWindowBoundaryError(error) {
    if (!(error instanceof Error))
        return false;
    return error.message === "Linux WSS target process is unavailable"
        || error.message === "Linux WSS target window is no longer visible"
        || error.message === "Linux WSS target window ownership changed"
        || error.message === "Linux WSS target window geometry is unavailable";
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function validateExactTarget(target) {
    if (!Number.isSafeInteger(target.processId) || target.processId <= 0) {
        throw new Error("Linux WSS surface requires a positive target process id");
    }
    if (!Number.isSafeInteger(target.windowId) || target.windowId <= 0) {
        throw new Error("Linux WSS physical surface requires an explicit positive target window id");
    }
}
function sameTarget(left, right) {
    return left.processId === right.processId && left.windowId === right.windowId;
}
function consumeDiagnostics(active, chunk, onStage) {
    if (active.failed)
        return;
    active.stderrBuffer += chunk.toString("utf8");
    if (active.stderrBuffer.length > MAX_DIAGNOSTIC_BUFFER_BYTES) {
        onStage("diagnostics_bounds");
        failActive(active, "Linux WSS exact-window helper diagnostics exceeded bounds");
        return;
    }
    for (;;) {
        const newline = active.stderrBuffer.indexOf("\n");
        if (newline < 0)
            return;
        const line = active.stderrBuffer.slice(0, newline).trim();
        active.stderrBuffer = active.stderrBuffer.slice(newline + 1);
        const match = /^MCP_HANDOFF_DIAGNOSTIC linux_stage=([a-z0-9_]{1,64})$/.exec(line);
        if (!match)
            continue;
        onStage(match[1]);
        if (match[1] === "input_applied") {
            const pending = active.pendingInputAck;
            if (!pending)
                continue;
            active.pendingInputAck = undefined;
            clearTimeout(pending.timer);
            pending.resolve();
        }
        else if (match[1] === "input_failure") {
            failActive(active, "Linux WSS exact-window helper input failed");
        }
    }
}
function boundedInputStage(stage) {
    if (stage === "input_focus_ready")
        return "focus_ready";
    if (stage === "input_pointer_move_ready")
        return "pointer_move_ready";
    if (stage === "input_pointer_authority_ready")
        return "pointer_authority_ready";
    if (stage === "input_pointer_down_sent")
        return "pointer_down_sent";
    if (stage === "input_pointer_post_authority_ready")
        return "pointer_post_authority_ready";
    if (stage === "input_tap_sent")
        return "tap_sent";
    if (stage === "input_key_down_sent")
        return "key_down_sent";
    if (stage === "input_key_authority_ready")
        return "key_authority_ready";
    if (stage === "input_key_up_sent")
        return "key_up_sent";
    if (stage === "input_applied")
        return "applied";
    return undefined;
}
function boundedInputFailureDetail(stage) {
    const match = /^input_xtest_(unavailable|busy|invalid|ack_timeout|write_failure|output_bounds|protocol_mismatch|unexpected_response|state_rejected|xtest_rejected|protocol_rejected|process_error|process_closed)$/.exec(stage);
    return match ? `xtest_${match[1]}` : undefined;
}
function boundedHelperStopReason(stage) {
    const match = /^host_stop_(capture_failure|input_failure|stdin_end|signal_term|signal_int|expiry|input_buffer_bounds|explicit_stop)$/.exec(stage);
    return match ? match[1] : undefined;
}
function boundedHelperCrashReason(stage) {
    if (stage === "host_crash_uncaught_exception")
        return "uncaught_exception";
    if (stage === "host_crash_main_rejection")
        return "main_rejection";
    return undefined;
}
function boundedHelperCrashClass(stage) {
    const match = /^host_crash_class_(pipe_epipe|stream_write_after_end|stream_destroyed|jpeg_parser|frame_writer|input_callback|xtest_callback|accessibility_callback|capture_callback|stream_internal|event_dispatch|child_process_internal|special_key|exact_window_revalidate|active_target_check|focus_target_check|scroll_input|text_input|host_input_apply|host_input_chain|host_module|unknown)$/.exec(stage);
    return match ? match[1] : undefined;
}
function boundedHelperCrashOrigin(stage) {
    const match = /^host_crash_origin_(uncaught_exception|unhandled_rejection|unknown)$/.exec(stage);
    return match ? match[1] : undefined;
}
function boundedHelperCrashErrorKind(stage) {
    const match = /^host_crash_error_(error|type_error|range_error|other)$/.exec(stage);
    return match ? match[1] : undefined;
}
function boundedHelperCrashMessageClass(stage) {
    const match = /^host_crash_message_(focus_not_owned|window_not_active|target_process_unavailable|window_not_visible|window_owner_changed|window_geometry_unavailable|special_key_geometry_changed|xtest_helper_unavailable|xtest_helper_busy|xtest_helper_ack_timeout|xtest_helper_rejected|atspi_unavailable|atspi_busy|atspi_timeout|atspi_readiness_timeout|atspi_response_failed|atspi_response_invalid|atspi_response_large|atspi_regions_many|atspi_region_invalid|atspi_region_bounds|atspi_write_failure|atspi_output_bounds|atspi_protocol_mismatch|atspi_unexpected_response|atspi_process_failed|atspi_process_closed|atspi_failed|helper_command_timeout|helper_command_failed|other)$/.exec(stage);
    return match ? match[1] : undefined;
}
function captureFailureCategory(stage) {
    if (stage === "capture_failure_x11")
        return "capture_x11";
    if (stage === "capture_failure_encoder")
        return "capture_encoder";
    if (stage === "capture_failure_option")
        return "capture_option";
    if (stage === "capture_failure_other")
        return "capture_other";
    if (stage === "diagnostics_bounds")
        return "diagnostics_bounds";
    return undefined;
}
function failActive(active, message) {
    if (active.failed)
        return;
    active.failed = true;
    const error = new Error(message);
    const pending = active.pendingInputAck;
    active.pendingInputAck = undefined;
    if (pending) {
        clearTimeout(pending.timer);
        pending.reject(error);
    }
    for (const waiter of active.frameWaiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
    }
    if (active.child.exitCode === null && active.child.signalCode === null)
        active.child.kill("SIGTERM");
}
async function stopActive(active) {
    if (active.child.exitCode !== null || active.child.signalCode !== null)
        return;
    try {
        active.child.stdin.write('{"kind":"stop"}\n');
    }
    catch { }
    active.child.stdin.end();
    const ended = await Promise.race([
        once(active.child, "close").then(() => true, () => true),
        new Promise((resolve) => setTimeout(() => resolve(false), HELPER_STOP_TIMEOUT_MS))
    ]);
    if (ended || active.child.exitCode !== null || active.child.signalCode !== null)
        return;
    active.child.kill("SIGTERM");
    await Promise.race([
        once(active.child, "close").catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 250))
    ]);
    if (active.child.exitCode === null && active.child.signalCode === null)
        active.child.kill("SIGKILL");
}
async function runBounded(executable, args, env) {
    const child = spawn(executable, args, { env, stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    let bytes = 0;
    child.stdout.on("data", (chunk) => {
        bytes += chunk.byteLength;
        if (bytes <= 64 * 1024)
            chunks.push(chunk);
    });
    const [code] = await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            child.kill("SIGKILL");
            reject(new Error("Linux WSS exact-window query timed out"));
        }, QUERY_TIMEOUT_MS);
        timer.unref();
        child.once("error", (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        child.once("close", (code, signal) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve([code, signal]);
        });
    });
    if (code !== 0 || bytes > 64 * 1024)
        throw new Error("Linux WSS exact-window query failed");
    return Buffer.concat(chunks).toString("utf8");
}
//# sourceMappingURL=linux-websocket-window-surface.js.map