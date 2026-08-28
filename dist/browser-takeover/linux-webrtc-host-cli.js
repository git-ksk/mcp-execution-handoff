#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { normalizedPointInWindow, scaledEvenWindowSize, selectExactBoundedWindow } from "../target-surface/os-window.js";
const MAX_HOST_FRAME_BYTES = 8 * 1024 * 1024;
const HELPER_COMMAND_TIMEOUT_MS = 2_000;
const MAX_INPUT_LINE_BYTES = 4 * 1024;
const MAX_PENDING_INPUT_BYTES = 8 * 1024;
const DEFAULT_FPS = 15;
const DEFAULT_MAX_WIDTH = 1280;
const DEFAULT_MAX_HEIGHT = 720;
const MIN_WINDOW_WIDTH = 160;
const MIN_WINDOW_HEIGHT = 120;
const XTEST_HELPER_ACK_TIMEOUT_MS = 2_000;
const XTEST_HELPER_MAX_OUTPUT_BYTES = 4_096;
const ATSPI_HELPER_ACK_TIMEOUT_MS = 1_500;
const ATSPI_HELPER_MAX_OUTPUT_BYTES = 8_192;
const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);
export function parseWindowIds(value) {
    const ids = value.split(/\s+/).filter(Boolean).map((item) => Number(item));
    return ids.filter((item) => Number.isSafeInteger(item) && item > 0);
}
export function parseWindowGeometry(value, expectedWindowId) {
    const fields = new Map();
    for (const line of value.split(/\r?\n/)) {
        const match = /^([A-Z]+)=(-?\d+)$/.exec(line.trim());
        if (match)
            fields.set(match[1], Number(match[2]));
    }
    const windowId = fields.get("WINDOW") ?? expectedWindowId;
    const x = fields.get("X");
    const y = fields.get("Y");
    const width = fields.get("WIDTH");
    const height = fields.get("HEIGHT");
    if (![windowId, x, y, width, height].every(Number.isSafeInteger))
        return undefined;
    if (windowId !== expectedWindowId || width < MIN_WINDOW_WIDTH || height < MIN_WINDOW_HEIGHT)
        return undefined;
    return { windowId, x: x, y: y, width: width, height: height };
}
export function scaledVideoSize(width, height) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || height < 2) {
        throw new Error("Linux WebRTC host received invalid window geometry");
    }
    return scaledEvenWindowSize(width, height, DEFAULT_MAX_WIDTH, DEFAULT_MAX_HEIGHT);
}
export function avccFromNalUnits(units) {
    const total = units.reduce((sum, unit) => sum + 4 + unit.byteLength, 0);
    const out = Buffer.allocUnsafe(total);
    let offset = 0;
    for (const unit of units) {
        out.writeUInt32BE(unit.byteLength, offset);
        offset += 4;
        unit.copy(out, offset);
        offset += unit.byteLength;
    }
    return out;
}
export function frameRecord(avcc, timestamp, keyframe, width, height) {
    if (avcc.byteLength < 1 || avcc.byteLength > MAX_HOST_FRAME_BYTES - 9)
        throw new Error("Linux WebRTC host frame is out of bounds");
    if (![timestamp, width, height].every(Number.isSafeInteger) || timestamp < 0 || width < 1 || width > 65_535 || height < 1 || height > 65_535) {
        throw new Error("Linux WebRTC host frame metadata is invalid");
    }
    const payload = Buffer.allocUnsafe(9 + avcc.byteLength);
    payload.writeUInt32BE(timestamp >>> 0, 0);
    payload[4] = keyframe ? 1 : 0;
    payload.writeUInt16BE(width, 5);
    payload.writeUInt16BE(height, 7);
    avcc.copy(payload, 9);
    const record = Buffer.allocUnsafe(5 + payload.byteLength);
    record[0] = 1;
    record.writeUInt32BE(payload.byteLength, 1);
    payload.copy(record, 5);
    return record;
}
function editableRecord(editable) {
    const record = Buffer.allocUnsafe(6);
    record[0] = 2;
    record.writeUInt32BE(1, 1);
    record[5] = editable ? 1 : 0;
    return record;
}
function editableRegionsControlLine(regions) {
    return `MCP_HANDOFF_CONTROL editable_regions=${regions.slice(0, 32).map((region) => region.slice(0, 4).join(",")).join(";")}\n`;
}
export function jpegFrameRecord(jpeg, width, height) {
    if (jpeg.byteLength < 4 || jpeg.byteLength > MAX_HOST_FRAME_BYTES - 4) {
        throw new Error("Linux WebSocket host JPEG frame is out of bounds");
    }
    if (jpeg.subarray(0, 2).compare(JPEG_SOI) !== 0 || jpeg.subarray(-2).compare(JPEG_EOI) !== 0) {
        throw new Error("Linux WebSocket host JPEG frame is invalid");
    }
    if (![width, height].every(Number.isSafeInteger) || width < 1 || width > 65_535 || height < 1 || height > 65_535) {
        throw new Error("Linux WebSocket host JPEG metadata is invalid");
    }
    const payload = Buffer.allocUnsafe(4 + jpeg.byteLength);
    payload.writeUInt16BE(width, 0);
    payload.writeUInt16BE(height, 2);
    jpeg.copy(payload, 4);
    const record = Buffer.allocUnsafe(5 + payload.byteLength);
    record[0] = 2;
    record.writeUInt32BE(payload.byteLength, 1);
    payload.copy(record, 5);
    return record;
}
export class JpegFrameParser {
    emit;
    pending = Buffer.alloc(0);
    constructor(emit) {
        this.emit = emit;
    }
    push(chunk) {
        if (chunk.byteLength === 0)
            return;
        this.pending = this.pending.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([this.pending, chunk]);
        this.drain();
    }
    end() {
        this.drain();
        this.pending = Buffer.alloc(0);
    }
    drain() {
        for (;;) {
            const start = this.pending.indexOf(JPEG_SOI);
            if (start < 0) {
                if (this.pending.byteLength > 1)
                    this.pending = this.pending.subarray(-1);
                return;
            }
            if (start > 0)
                this.pending = this.pending.subarray(start);
            const end = this.pending.indexOf(JPEG_EOI, 2);
            if (end < 0) {
                if (this.pending.byteLength > MAX_HOST_FRAME_BYTES) {
                    throw new Error("Linux WebSocket host JPEG buffer exceeded bounds");
                }
                return;
            }
            const frameEnd = end + JPEG_EOI.byteLength;
            const jpeg = this.pending.subarray(0, frameEnd);
            this.pending = this.pending.subarray(frameEnd);
            if (jpeg.byteLength > MAX_HOST_FRAME_BYTES) {
                throw new Error("Linux WebSocket host JPEG frame exceeded bounds");
            }
            this.emit(Buffer.from(jpeg));
        }
    }
}
function startCodeAt(buffer, offset) {
    for (let i = offset; i + 3 <= buffer.length; i += 1) {
        if (buffer[i] !== 0 || buffer[i + 1] !== 0)
            continue;
        if (buffer[i + 2] === 1)
            return i;
        if (i + 3 < buffer.length && buffer[i + 2] === 0 && buffer[i + 3] === 1)
            return i;
    }
    return -1;
}
function startCodeLength(buffer, offset) {
    return buffer[offset + 2] === 1 ? 3 : 4;
}
/** Splits Annex-B H.264 into access units using mandatory AUD NALs emitted by the Linux encoder. */
export class AnnexBAccessUnitParser {
    emit;
    pending = Buffer.alloc(0);
    current = [];
    constructor(emit) {
        this.emit = emit;
    }
    push(chunk) {
        if (chunk.byteLength === 0)
            return;
        this.pending = this.pending.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([this.pending, chunk]);
        this.drain(false);
    }
    end() {
        this.drain(true);
        this.emitCurrent();
        this.pending = Buffer.alloc(0);
    }
    drain(flush) {
        let first = startCodeAt(this.pending, 0);
        if (first < 0) {
            if (this.pending.byteLength > MAX_HOST_FRAME_BYTES)
                throw new Error("Linux WebRTC host H.264 buffer exceeded bounds");
            return;
        }
        if (first > 0)
            this.pending = this.pending.subarray(first);
        for (;;) {
            first = startCodeAt(this.pending, 0);
            if (first !== 0)
                return;
            const header = startCodeLength(this.pending, 0);
            const next = startCodeAt(this.pending, header);
            if (next < 0) {
                if (!flush)
                    return;
                const nal = this.pending.subarray(header);
                this.pending = Buffer.alloc(0);
                this.acceptNal(nal);
                return;
            }
            const nal = this.pending.subarray(header, next);
            this.pending = this.pending.subarray(next);
            this.acceptNal(nal);
        }
    }
    acceptNal(nal) {
        if (nal.byteLength < 1)
            return;
        const type = nal[0] & 0x1f;
        if (type === 9) {
            this.emitCurrent();
            return;
        }
        this.current.push(Buffer.from(nal));
        const bytes = this.current.reduce((sum, unit) => sum + unit.byteLength + 4, 0);
        if (bytes > MAX_HOST_FRAME_BYTES - 9)
            throw new Error("Linux WebRTC host access unit exceeded bounds");
    }
    emitCurrent() {
        if (this.current.length === 0)
            return;
        const units = this.current;
        this.current = [];
        this.emit(units, units.some((unit) => (unit[0] & 0x1f) === 5));
    }
}
class LatestFrameWriter {
    blocked = false;
    latestFrame;
    latestControl;
    submit(record) { this.submitRecord(record, false); }
    submitControl(record) { this.submitRecord(record, true); }
    submitRecord(record, control) {
        if (this.blocked) {
            if (control)
                this.latestControl = record;
            else
                this.latestFrame = record;
            return;
        }
        if (!process.stdout.write(record)) {
            this.blocked = true;
            process.stdout.once("drain", () => this.drain());
        }
    }
    drain() {
        this.blocked = false;
        const control = this.latestControl;
        if (control) {
            this.latestControl = undefined;
            this.submitRecord(control, true);
            return;
        }
        const frame = this.latestFrame;
        this.latestFrame = undefined;
        if (frame)
            this.submitRecord(frame, false);
    }
}
function boundedEnvironment(display) {
    return { DISPLAY: display, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
}
function boundedAccessibilityEnvironment(display) {
    const env = boundedEnvironment(display);
    const bus = process.env.DBUS_SESSION_BUS_ADDRESS;
    if (!bus || bus.length > 2_048 || /[\0\r\n]/.test(bus)) {
        throw new Error("Linux accessibility session bus is unavailable");
    }
    env.DBUS_SESSION_BUS_ADDRESS = bus;
    const runtimeDir = process.env.XDG_RUNTIME_DIR;
    if (runtimeDir && runtimeDir.startsWith("/") && runtimeDir.length <= 512 && !/[\0\r\n]/.test(runtimeDir)) {
        env.XDG_RUNTIME_DIR = runtimeDir;
    }
    env.NO_AT_BRIDGE = "0";
    return env;
}
async function runCommand(executable, args, display) {
    const child = spawn(executable, args, { env: boundedEnvironment(display), stdio: ["ignore", "pipe", "ignore"] });
    const stdout = [];
    let bytes = 0;
    child.stdout.on("data", (chunk) => {
        bytes += chunk.byteLength;
        if (bytes <= 64 * 1024)
            stdout.push(chunk);
    });
    const result = await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            child.kill("SIGKILL");
            reject(new Error(`Linux WebRTC host helper command timed out: ${executable}`));
        }, HELPER_COMMAND_TIMEOUT_MS);
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
    const [code] = result;
    if (code !== 0 || bytes > 64 * 1024)
        throw new Error(`Linux WebRTC host helper command failed: ${executable}`);
    return Buffer.concat(stdout).toString("utf8");
}
class LinuxXTestPointerHelper {
    child;
    output = "";
    readyState = "waiting";
    readyPromise;
    readyResolve;
    readyReject;
    readyTimer;
    pending;
    closing;
    lastFailureValue = "none";
    get lastFailure() {
        return this.lastFailureValue;
    }
    constructor(executable, display) {
        this.readyPromise = new Promise((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
        });
        this.readyTimer = setTimeout(() => {
            if (this.readyState !== "waiting")
                return;
            this.readyState = "failed";
            this.lastFailureValue = "ack_timeout";
            this.readyReject(new Error("Linux XTEST input helper readiness timed out"));
            void this.close().catch(() => undefined);
        }, XTEST_HELPER_ACK_TIMEOUT_MS);
        this.child = spawn(executable, [], {
            env: boundedEnvironment(display),
            stdio: ["pipe", "pipe", "ignore"]
        });
        this.child.stdout.on("data", (chunk) => this.consume(chunk));
        this.child.once("error", () => this.fail("Linux XTEST input helper failed", "process_error"));
        this.child.once("close", () => this.fail("Linux XTEST input helper closed", "process_closed"));
    }
    static async start(executable, display) {
        const helper = new LinuxXTestPointerHelper(executable, display);
        await helper.readyPromise;
        return helper;
    }
    move(x, y) {
        return this.command(`MOVE ${x} ${y}`, "MOVE");
    }
    down(cleanupX, cleanupY) {
        return this.command(`DOWN 1 ${cleanupX} ${cleanupY}`, "DOWN");
    }
    up() {
        return this.command("UP 1", "UP");
    }
    cancel() {
        return this.command("CANCEL 1", "CANCEL");
    }
    keyDown(key) {
        return this.command(`KEYDOWN ${key === "Backspace" ? "BACKSPACE" : "RETURN"}`, "KEYDOWN");
    }
    keyUp(key) {
        return this.command(`KEYUP ${key === "Backspace" ? "BACKSPACE" : "RETURN"}`, "KEYUP");
    }
    cancelKey() {
        return this.command("CANCELKEY", "CANCELKEY");
    }
    async close() {
        if (this.closing)
            return this.closing;
        this.closing = (async () => {
            clearTimeout(this.readyTimer);
            if (this.child.exitCode !== null || this.child.signalCode !== null)
                return;
            // EOF is part of the helper protocol: if Button1 or one admitted special key is armed, the
            // helper performs its bounded release and XSync before exiting. Never fall back to xdotool.
            this.child.stdin.end();
            const closed = once(this.child, "close").then(() => true, () => true);
            const ended = await Promise.race([
                closed,
                new Promise((resolve) => setTimeout(() => resolve(false), 750))
            ]);
            if (ended || this.child.exitCode !== null || this.child.signalCode !== null)
                return;
            this.child.kill("SIGTERM");
            await Promise.race([
                once(this.child, "close").catch(() => undefined),
                new Promise((resolve) => setTimeout(resolve, 250))
            ]);
            if (this.child.exitCode === null && this.child.signalCode === null)
                this.child.kill("SIGKILL");
        })();
        return this.closing;
    }
    command(line, expected) {
        if (this.readyState !== "ready" || this.closing || this.child.exitCode !== null || this.child.signalCode !== null) {
            this.lastFailureValue = "unavailable";
            return Promise.reject(new Error("Linux XTEST input helper is unavailable"));
        }
        if (this.pending) {
            this.lastFailureValue = "busy";
            return Promise.reject(new Error("Linux XTEST input helper is busy"));
        }
        if (!/^[A-Z0-9 -]{2,96}$/.test(line)) {
            this.lastFailureValue = "invalid";
            return Promise.reject(new Error("Linux XTEST input helper command is invalid"));
        }
        this.lastFailureValue = "none";
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (!this.pending || this.pending.expected !== expected)
                    return;
                this.pending = undefined;
                this.lastFailureValue = "ack_timeout";
                reject(new Error("Linux XTEST input helper acknowledgement timed out"));
                void this.close().catch(() => undefined);
            }, XTEST_HELPER_ACK_TIMEOUT_MS);
            this.pending = { expected, resolve, reject, timer };
            this.child.stdin.write(`${line}\n`, (error) => {
                if (error)
                    this.fail("Linux XTEST input helper write failed", "write_failure");
            });
        });
    }
    consume(chunk) {
        this.output += chunk.toString("utf8");
        if (this.output.length > XTEST_HELPER_MAX_OUTPUT_BYTES) {
            this.fail("Linux XTEST input helper output exceeded limit", "output_bounds");
            void this.close().catch(() => undefined);
            return;
        }
        while (true) {
            const newline = this.output.indexOf("\n");
            if (newline < 0)
                return;
            const line = this.output.slice(0, newline).trim();
            this.output = this.output.slice(newline + 1);
            if (this.readyState === "waiting") {
                if (line !== "READY 2") {
                    this.fail("Linux XTEST input helper protocol mismatch", "protocol_mismatch");
                    void this.close().catch(() => undefined);
                    return;
                }
                clearTimeout(this.readyTimer);
                this.readyState = "ready";
                this.readyResolve();
                continue;
            }
            const pending = this.pending;
            if (!pending) {
                this.fail("Linux XTEST input helper emitted an unexpected response", "unexpected_response");
                void this.close().catch(() => undefined);
                return;
            }
            clearTimeout(pending.timer);
            this.pending = undefined;
            if (line === `OK ${pending.expected}`) {
                pending.resolve();
                continue;
            }
            this.lastFailureValue = line === "ERR STATE"
                ? "state_rejected"
                : line === "ERR XTEST"
                    ? "xtest_rejected"
                    : line === "ERR PROTOCOL"
                        ? "protocol_rejected"
                        : "protocol_mismatch";
            pending.reject(new Error("Linux XTEST input helper rejected a command"));
            void this.close().catch(() => undefined);
            return;
        }
    }
    fail(message, failure) {
        if (this.lastFailureValue === "none")
            this.lastFailureValue = failure;
        if (this.readyState === "waiting") {
            clearTimeout(this.readyTimer);
            this.readyState = "failed";
            this.readyReject(new Error(message));
        }
        const pending = this.pending;
        if (!pending)
            return;
        clearTimeout(pending.timer);
        this.pending = undefined;
        pending.reject(new Error(message));
    }
}
export function parseLinuxAtSpiSnapshotLine(line) {
    if (line === "NO")
        return undefined;
    const match = /^OK focus=(0|1) regions=(.*)$/.exec(line);
    if (!match)
        throw new Error("Linux AT-SPI editable helper response is invalid");
    const payload = match[2] ?? "";
    if (payload.length > 1_024)
        throw new Error("Linux AT-SPI editable helper response is too large");
    const regions = [];
    if (payload) {
        const encoded = payload.split(";");
        if (encoded.length > 32)
            throw new Error("Linux AT-SPI editable helper returned too many regions");
        for (const item of encoded) {
            const regionMatch = /^(\d{1,5}),(\d{1,5}),(\d{1,5}),(\d{1,5})$/.exec(item);
            if (!regionMatch)
                throw new Error("Linux AT-SPI editable helper region is invalid");
            const region = regionMatch.slice(1).map(Number);
            const [x, y, width, height] = region;
            if (!region.every(Number.isSafeInteger) || x < 0 || y < 0 || width < 1 || height < 1 || x + width > 10_000 || y + height > 10_000) {
                throw new Error("Linux AT-SPI editable helper region is out of bounds");
            }
            regions.push(region);
        }
    }
    return { regions, focusEditable: match[1] === "1" };
}
class LinuxAtSpiEditableHelper {
    child;
    output = "";
    readyState = "waiting";
    readyPromise;
    readyResolve;
    readyTimer;
    pending;
    closing;
    constructor(executable, targetPid, geometry, display) {
        this.readyPromise = new Promise((resolve) => {
            this.readyResolve = resolve;
        });
        this.readyTimer = setTimeout(() => {
            if (this.readyState !== "waiting")
                return;
            this.readyState = "failed";
            this.readyResolve(false);
            void this.close().catch(() => undefined);
        }, ATSPI_HELPER_ACK_TIMEOUT_MS);
        this.child = spawn(executable, [
            "--pid", String(targetPid),
            "--x", String(geometry.x),
            "--y", String(geometry.y),
            "--width", String(geometry.width),
            "--height", String(geometry.height)
        ], {
            env: boundedAccessibilityEnvironment(display),
            stdio: ["pipe", "pipe", "ignore"]
        });
        this.child.stdout.on("data", (chunk) => this.consume(chunk));
        this.child.once("error", () => this.fail("Linux AT-SPI editable helper failed"));
        this.child.once("close", () => this.fail("Linux AT-SPI editable helper closed"));
    }
    static async start(executable, targetPid, geometry, display) {
        const helper = new LinuxAtSpiEditableHelper(executable, targetPid, geometry, display);
        return await helper.readyPromise ? helper : undefined;
    }
    snapshot() {
        if (this.readyState !== "ready" || this.closing || this.child.exitCode !== null || this.child.signalCode !== null) {
            return Promise.reject(new Error("Linux AT-SPI editable helper is unavailable"));
        }
        if (this.pending)
            return Promise.reject(new Error("Linux AT-SPI editable helper is busy"));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (!this.pending)
                    return;
                this.pending = undefined;
                reject(new Error("Linux AT-SPI editable helper snapshot timed out"));
            }, ATSPI_HELPER_ACK_TIMEOUT_MS);
            this.pending = { resolve, reject, timer };
            this.child.stdin.write("snapshot\n", (error) => {
                if (error)
                    this.fail("Linux AT-SPI editable helper write failed");
            });
        });
    }
    async close() {
        if (this.closing)
            return this.closing;
        this.closing = (async () => {
            clearTimeout(this.readyTimer);
            if (this.child.exitCode !== null || this.child.signalCode !== null)
                return;
            this.child.stdin.end();
            const ended = await Promise.race([
                once(this.child, "close").then(() => true, () => true),
                new Promise((resolve) => setTimeout(() => resolve(false), 500))
            ]);
            if (ended || this.child.exitCode !== null || this.child.signalCode !== null)
                return;
            this.child.kill("SIGTERM");
            await Promise.race([
                once(this.child, "close").catch(() => undefined),
                new Promise((resolve) => setTimeout(resolve, 200))
            ]);
            if (this.child.exitCode === null && this.child.signalCode === null)
                this.child.kill("SIGKILL");
        })();
        return this.closing;
    }
    consume(chunk) {
        this.output += chunk.toString("utf8");
        if (this.output.length > ATSPI_HELPER_MAX_OUTPUT_BYTES) {
            this.fail("Linux AT-SPI editable helper output exceeded limit");
            void this.close().catch(() => undefined);
            return;
        }
        while (true) {
            const newline = this.output.indexOf("\n");
            if (newline < 0)
                return;
            const line = this.output.slice(0, newline).trim();
            this.output = this.output.slice(newline + 1);
            if (this.readyState === "waiting") {
                if (line !== "READY 1") {
                    this.fail("Linux AT-SPI editable helper protocol mismatch");
                    void this.close().catch(() => undefined);
                    return;
                }
                clearTimeout(this.readyTimer);
                this.readyState = "ready";
                this.readyResolve(true);
                continue;
            }
            const pending = this.pending;
            if (!pending) {
                this.fail("Linux AT-SPI editable helper emitted an unexpected response");
                void this.close().catch(() => undefined);
                return;
            }
            clearTimeout(pending.timer);
            this.pending = undefined;
            try {
                pending.resolve(parseLinuxAtSpiSnapshotLine(line));
            }
            catch (error) {
                pending.reject(error instanceof Error ? error : new Error("Linux AT-SPI editable helper response failed"));
                void this.close().catch(() => undefined);
                return;
            }
        }
    }
    fail(message) {
        if (this.readyState === "waiting") {
            clearTimeout(this.readyTimer);
            this.readyState = "failed";
            this.readyResolve(false);
        }
        const pending = this.pending;
        if (!pending)
            return;
        clearTimeout(pending.timer);
        this.pending = undefined;
        pending.reject(new Error(message));
    }
}
function packagedLinuxAtSpiEditableHelper(moduleUrl) {
    return fileURLToPath(new URL("../native/mcp-handoff-linux-atspi-helper", moduleUrl));
}
function packagedLinuxXTestHelper(moduleUrl) {
    return fileURLToPath(new URL("../native/mcp-handoff-linux-xtest-helper", moduleUrl));
}
export function parseOptionalTargetWindowId(value) {
    if (value === undefined)
        return undefined;
    if (!/^[1-9]\d*$/.test(value))
        throw new Error("TAKEOVER_WEBRTC_TARGET_WINDOW_ID is invalid");
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0)
        throw new Error("TAKEOVER_WEBRTC_TARGET_WINDOW_ID is invalid");
    return parsed;
}
async function resolveExactWindow(targetPid, targetWindowId, display, xdotool) {
    const deadline = Date.now() + 7_000;
    let observedMultiple = false;
    while (Date.now() < deadline) {
        const rawIds = await runCommand(xdotool, ["search", "--onlyvisible", "--pid", String(targetPid)], display).catch(() => "");
        const ids = [...new Set(parseWindowIds(rawIds))];
        if (targetWindowId !== undefined) {
            const pidText = await runCommand(xdotool, ["getwindowpid", String(targetWindowId)], display).catch(() => "");
            const observedPid = Number(pidText.trim());
            if (Number.isSafeInteger(observedPid) && observedPid > 0 && observedPid !== targetPid) {
                throw new Error("Linux WebRTC requested window is not owned by the target browser PID");
            }
            if (ids.includes(targetWindowId) && observedPid === targetPid) {
                const geometry = parseWindowGeometry(await runCommand(xdotool, ["getwindowgeometry", "--shell", String(targetWindowId)], display).catch(() => ""), targetWindowId);
                if (geometry)
                    return geometry;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
            continue;
        }
        const candidates = [];
        for (const id of ids) {
            const pidText = await runCommand(xdotool, ["getwindowpid", String(id)], display).catch(() => "");
            if (Number(pidText.trim()) !== targetPid)
                continue;
            const geometry = parseWindowGeometry(await runCommand(xdotool, ["getwindowgeometry", "--shell", String(id)], display).catch(() => ""), id);
            if (geometry)
                candidates.push(geometry);
        }
        if (candidates.length === 1) {
            const selected = selectExactBoundedWindow(candidates.map((candidate) => ({
                id: candidate.windowId,
                x: candidate.x,
                y: candidate.y,
                width: candidate.width,
                height: candidate.height
            })), { minWidth: MIN_WINDOW_WIDTH, minHeight: MIN_WINDOW_HEIGHT });
            return {
                windowId: selected.id,
                x: selected.x,
                y: selected.y,
                width: selected.width,
                height: selected.height
            };
        }
        // A normal Chromium launch can briefly expose more than one top-level X11 window while the
        // browser/session manager settles. Never choose among ambiguous windows; keep waiting within
        // the existing bounded readiness interval and proceed only after exactly one remains.
        if (candidates.length > 1)
            observedMultiple = true;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (targetWindowId !== undefined) {
        throw new Error("Linux WebRTC host could not resolve the requested eligible window for the target browser PID");
    }
    if (observedMultiple) {
        throw new Error("Linux WebRTC host did not converge to exactly one eligible window for the target browser PID");
    }
    throw new Error("Linux WebRTC host could not resolve exactly one eligible window for the target browser PID");
}
function parseHostInput(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const record = value;
    if (record.kind === "stop" || record.kind === "requestIDR")
        return { kind: record.kind };
    if (record.kind === "tap") {
        const x = Number(record.x), y = Number(record.y);
        return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { kind: "tap", x, y } : undefined;
    }
    if (record.kind === "pointer_button" && record.button === "primary" && (record.state === "down" || record.state === "up")) {
        const x = Number(record.x), y = Number(record.y);
        return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1
            ? { kind: "pointer_button", button: "primary", state: record.state, x, y }
            : undefined;
    }
    if (record.kind === "scroll") {
        const deltaX = Number(record.deltaX), deltaY = Number(record.deltaY);
        return Number.isFinite(deltaX) && Number.isFinite(deltaY) && Math.abs(deltaX) <= 2_000 && Math.abs(deltaY) <= 2_000
            ? { kind: "scroll", deltaX, deltaY }
            : undefined;
    }
    if (record.kind === "text" && typeof record.text === "string") {
        const bytes = Buffer.byteLength(record.text, "utf8");
        return bytes >= 1 && bytes <= MAX_INPUT_LINE_BYTES && [...record.text].length <= 1_024 ? { kind: "text", text: record.text } : undefined;
    }
    if (record.kind === "key" && (record.key === "Backspace" || record.key === "Enter"))
        return { kind: "key", key: record.key };
    return undefined;
}
class LinuxWindowInput {
    geometry;
    targetPid;
    display;
    xdotool;
    pointer;
    primaryPressed = false;
    primaryPoint;
    pressedKey;
    constructor(geometry, targetPid, display, xdotool, pointer) {
        this.geometry = geometry;
        this.targetPid = targetPid;
        this.display = display;
        this.xdotool = xdotool;
        this.pointer = pointer;
    }
    async apply(input) {
        // Revalidate the exact X11 window immediately before every Human mutation. Window ids can be
        // recycled after a process exits; stale geometry must never widen input authority to a new
        // owner. A move/resize of the same owned window refreshes only its bounded geometry.
        this.geometry = await this.currentOwnedGeometry();
        const continuingPrimaryRelease = input.kind === "pointer_button" && input.state === "up" && this.primaryPressed;
        if (input.kind === "pointer_button" && input.state === "up" && !this.primaryPressed) {
            throw new Error("Linux WebRTC primary button is not pressed");
        }
        // Establish exact-window activation before a new pointer lifecycle, scroll, text, or key.
        // A primary release is different: mutating WM activation/focus between the admitted down/up
        // pair can cancel Chromium's click lifecycle. For release, revalidate ownership above and
        // verify active/focus below without issuing another focus mutation while Button1 is held.
        if (!continuingPrimaryRelease) {
            const pointerLifecycle = input.kind === "tap" || input.kind === "pointer_button";
            // Avoid perturbing an already-authorized pointer route. Openbox and other reparenting WMs
            // can own passive click-to-focus grabs; repeatedly sending _NET_ACTIVE_WINDOW immediately
            // before XTEST Button1 creates needless WM bookkeeping. If active/focus already prove exact
            // authority, leave the WM untouched. Otherwise request activation through EWMH and verify it.
            const alreadyAuthorized = pointerLifecycle
                && await this.activeTargetOnce()
                && await this.inputFocusOwnedByTargetOnce();
            if (!alreadyAuthorized) {
                await runCommand(this.xdotool, ["windowactivate", String(this.geometry.windowId)], this.display);
            }
            // Let the EWMH-aware window manager own pointer focus transitions. Calling windowfocus here
            // would bypass the WM with XSetInputFocus and can diverge from its click/grab bookkeeping.
            // Scroll retains the legacy direct-focus behavior; pointer down proceeds only after the
            // exact active/focus checks below prove the target already owns authority.
            if (input.kind === "scroll") {
                await runCommand(this.xdotool, ["windowfocus", "--sync", String(this.geometry.windowId)], this.display);
            }
        }
        await this.confirmActiveTarget();
        await this.confirmInputFocusOwnedByTarget();
        process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=input_focus_ready\n");
        if (input.kind === "tap" || input.kind === "pointer_button") {
            const point = normalizedPointInWindow({
                id: this.geometry.windowId,
                x: this.geometry.x,
                y: this.geometry.y,
                width: this.geometry.width,
                height: this.geometry.height
            }, input.x, input.y);
            const x = Math.round(point.x);
            const y = Math.round(point.y);
            if (input.kind === "tap") {
                await this.postPrimaryButton("down", x, y);
                await new Promise((resolve) => setTimeout(resolve, 20));
                await this.postPrimaryButton("up", x, y);
                process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=input_tap_sent\n");
                return;
            }
            await this.postPrimaryButton(input.state, x, y);
            if (input.state === "up")
                process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=input_tap_sent\n");
            return;
        }
        if (input.kind === "scroll") {
            await this.scrollAxis(input.deltaY ?? 0, 4, 5);
            await this.scrollAxis(input.deltaX ?? 0, 6, 7);
            return;
        }
        if (input.kind === "key") {
            await this.pressSpecialKey(input.key);
            return;
        }
        await this.typeText(input.text);
    }
    async pressSpecialKey(key) {
        if (this.pressedKey)
            throw new Error("Linux WebRTC special key is already pressed");
        const expected = { ...this.geometry };
        try {
            await this.pointer.keyDown(key);
            this.pressedKey = key;
            process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=input_key_down_sent\n");
            // KEYUP is a second Human mutation. Revalidate the exact target after the X server ACK for
            // KEYDOWN and before releasing it. If authority changed, cleanup releases only the key this
            // helper owns; it never clears modifiers or unrelated local keyboard state.
            const current = await this.currentOwnedGeometry();
            if (current.windowId !== expected.windowId
                || current.x !== expected.x
                || current.y !== expected.y
                || current.width !== expected.width
                || current.height !== expected.height) {
                throw new Error("Linux WebRTC target geometry changed during special key press");
            }
            this.geometry = current;
            await this.confirmActiveTarget();
            await this.confirmInputFocusOwnedByTarget();
            process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=input_key_authority_ready\n");
            await this.pointer.keyUp(key);
            this.pressedKey = undefined;
            process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=input_key_up_sent\n");
        }
        catch (error) {
            if (this.pressedKey) {
                await this.pointer.cancelKey().catch(() => undefined);
                this.pressedKey = undefined;
            }
            throw error;
        }
    }
    async postPrimaryButton(state, x, y) {
        if (state === "down") {
            if (this.primaryPressed)
                throw new Error("Linux WebRTC primary button is already pressed");
            const geometryBeforeMove = { ...this.geometry };
            const cleanup = await this.cancellationPoint({ x, y });
            try {
                // The XTEST helper still owns only injection state and never receives PID/XID/window policy.
                // MOVE is acknowledged only after XSync(False) and an exact XQueryPointer coordinate check.
                await this.pointer.move(x, y);
                process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=input_pointer_move_ready\n");
                // MOVE itself is a Human mutation, but DOWN is a separate mutation. Revalidate exact
                // PID/window ownership and active/focus after the X server ACK. A geometry change invalidates
                // the already-admitted root point instead of silently retargeting it.
                const currentGeometry = await this.currentOwnedGeometry();
                if (currentGeometry.windowId !== geometryBeforeMove.windowId
                    || currentGeometry.x !== geometryBeforeMove.x
                    || currentGeometry.y !== geometryBeforeMove.y
                    || currentGeometry.width !== geometryBeforeMove.width
                    || currentGeometry.height !== geometryBeforeMove.height) {
                    throw new Error("Linux WebRTC target geometry changed during primary press admission");
                }
                this.geometry = currentGeometry;
                await this.confirmActiveTarget();
                await this.confirmInputFocusOwnedByTarget();
                process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=input_pointer_authority_ready\n");
                // DOWN is acknowledged by the native helper only after XTestFakeButtonEvent, XSync(False),
                // Button1Mask=true, and an unchanged root pointer position. Treat that server-processed ACK
                // as the X11 compatibility barrier, then immediately revalidate the exact authority tuple.
                await this.pointer.down(cleanup.x, cleanup.y);
                process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=input_pointer_down_sent\n");
                this.primaryPressed = true;
                this.primaryPoint = { x, y };
                await this.confirmPostDownAuthority(geometryBeforeMove);
                process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=input_pointer_post_authority_ready\n");
                return;
            }
            catch (error) {
                if (this.primaryPressed) {
                    await this.pointer.cancel().catch(() => undefined);
                    this.primaryPressed = false;
                    this.primaryPoint = undefined;
                }
                throw error;
            }
        }
        const pressed = this.primaryPoint;
        if (!this.primaryPressed || !pressed)
            throw new Error("Linux WebRTC primary button is not pressed");
        // `pointer_button` remains a tap lifecycle, not a drag API. Do not inject a same-position
        // MotionNotify immediately before release; Chromium's X11 injector deliberately avoids that.
        if (Math.abs(pressed.x - x) > 1 || Math.abs(pressed.y - y) > 1) {
            throw new Error("Linux WebRTC primary release point changed");
        }
        await this.pointer.up();
        this.primaryPressed = false;
        this.primaryPoint = undefined;
    }
    inputFailureDiagnosticStage() {
        const failure = this.pointer.lastFailure;
        return failure === "none" ? undefined : `input_xtest_${failure}`;
    }
    async releaseAll() {
        if (this.pressedKey) {
            await this.pointer.cancelKey().catch(() => undefined);
            this.pressedKey = undefined;
        }
        if (!this.primaryPressed)
            return;
        // The helper was armed with a Node-computed safe cleanup point before DOWN. CANCEL performs
        // move-away + Button1 release + XSync on the same connection. Never fall back to xdotool.
        await this.pointer.cancel().catch(() => undefined);
        this.primaryPressed = false;
        this.primaryPoint = undefined;
    }
    async shutdown() {
        await this.releaseAll();
        await this.pointer.close();
    }
    async confirmPostDownAuthority(expected) {
        const current = await this.currentOwnedGeometry();
        if (current.windowId !== expected.windowId
            || current.x !== expected.x
            || current.y !== expected.y
            || current.width !== expected.width
            || current.height !== expected.height) {
            throw new Error("Linux WebRTC target geometry changed after primary press");
        }
        this.geometry = current;
        if (!await this.activeTargetOnce()) {
            throw new Error("Linux WebRTC target window lost active authority after primary press");
        }
        if (!await this.inputFocusOwnedByTargetOnce()) {
            throw new Error("Linux WebRTC target process lost input focus after primary press");
        }
    }
    async cancellationPoint(pressedPoint) {
        const raw = await runCommand(this.xdotool, ["getdisplaygeometry"], this.display).catch(() => "");
        const match = /^(\d+)\s+(\d+)$/.exec(raw.trim());
        const width = match ? Number(match[1]) : 0;
        const height = match ? Number(match[2]) : 0;
        const pressed = pressedPoint ?? this.primaryPoint ?? { x: this.geometry.x, y: this.geometry.y };
        if (Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 1 && height > 1) {
            const safeX = Math.min(Math.max(pressed.x, 1), width - 2);
            const safeY = Math.min(Math.max(pressed.y, 1), height - 2);
            const margin = 2;
            if (this.geometry.x - margin >= 0)
                return { x: this.geometry.x - margin, y: safeY };
            if (this.geometry.x + this.geometry.width + margin < width) {
                return { x: this.geometry.x + this.geometry.width + margin, y: safeY };
            }
            if (this.geometry.y - margin >= 0)
                return { x: safeX, y: this.geometry.y - margin };
            if (this.geometry.y + this.geometry.height + margin < height) {
                return { x: safeX, y: this.geometry.y + this.geometry.height + margin };
            }
            // A full-display target has no off-window point. Fall back to the display corner farthest
            // from the original press so cleanup becomes an interrupted drag/release, not a control click.
            const candidates = [
                { x: 1, y: 1 },
                { x: width - 2, y: 1 },
                { x: 1, y: height - 2 },
                { x: width - 2, y: height - 2 }
            ];
            return candidates.reduce((best, candidate) => {
                const bestDistance = Math.hypot(best.x - pressed.x, best.y - pressed.y);
                const candidateDistance = Math.hypot(candidate.x - pressed.x, candidate.y - pressed.y);
                return candidateDistance > bestDistance ? candidate : best;
            });
        }
        return { x: Math.max(0, this.geometry.x - 2), y: Math.max(0, this.geometry.y - 2) };
    }
    async currentOwnedGeometry() {
        try {
            process.kill(this.targetPid, 0);
        }
        catch {
            throw new Error("Linux WebRTC target process is unavailable");
        }
        const visibleRaw = await runCommand(this.xdotool, ["search", "--onlyvisible", "--pid", String(this.targetPid)], this.display).catch(() => "");
        if (!parseWindowIds(visibleRaw).includes(this.geometry.windowId)) {
            throw new Error("Linux WebRTC target window is no longer visible");
        }
        const pidText = await runCommand(this.xdotool, ["getwindowpid", String(this.geometry.windowId)], this.display).catch(() => "");
        if (Number(pidText.trim()) !== this.targetPid) {
            throw new Error("Linux WebRTC target window ownership changed");
        }
        const geometry = parseWindowGeometry(await runCommand(this.xdotool, ["getwindowgeometry", "--shell", String(this.geometry.windowId)], this.display).catch(() => ""), this.geometry.windowId);
        if (!geometry)
            throw new Error("Linux WebRTC target window geometry is unavailable");
        return geometry;
    }
    async activeTargetOnce() {
        const active = await runCommand(this.xdotool, ["getactivewindow"], this.display).catch(() => "");
        return Number(active.trim()) === this.geometry.windowId;
    }
    async inputFocusOwnedByTargetOnce() {
        const focused = await runCommand(this.xdotool, ["getwindowfocus"], this.display).catch(() => "");
        const focusedWindowId = Number(focused.trim());
        if (!Number.isSafeInteger(focusedWindowId) || focusedWindowId <= 0)
            return false;
        if (focusedWindowId === this.geometry.windowId)
            return true;
        const focusedPid = await runCommand(this.xdotool, ["getwindowpid", String(focusedWindowId)], this.display).catch(() => "");
        return Number(focusedPid.trim()) === this.targetPid;
    }
    async confirmActiveTarget() {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            if (await this.activeTargetOnce())
                return;
            if (attempt < 4)
                await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("Linux WebRTC target window did not become active");
    }
    async confirmInputFocusOwnedByTarget() {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            if (await this.inputFocusOwnedByTargetOnce())
                return;
            if (attempt < 4)
                await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("Linux WebRTC input focus is not owned by the target process");
    }
    async scrollAxis(delta, negativeButton, positiveButton) {
        if (!delta)
            return;
        const repeats = Math.max(1, Math.min(12, Math.ceil(Math.abs(delta) / 80)));
        const button = delta < 0 ? negativeButton : positiveButton;
        await runCommand(this.xdotool, ["click", "--window", String(this.geometry.windowId), "--repeat", String(repeats), String(button)], this.display);
    }
    async typeText(text) {
        const child = spawn(this.xdotool, ["type", "--clearmodifiers", "--delay", "5", "--file", "-"], {
            env: boundedEnvironment(this.display),
            stdio: ["pipe", "ignore", "ignore"]
        });
        child.once("error", () => undefined);
        child.stdin.on("error", () => undefined);
        child.stdin.end(Buffer.from(text, "utf8"));
        const [code] = await once(child, "close");
        if (code !== 0)
            throw new Error("Linux WebRTC host text injection failed");
    }
}
function classifyFfmpegFailure(stderr) {
    const value = stderr.toLowerCase();
    if (/x11|display|xcb|cannot open|failed to capture|window/.test(value))
        return "x11";
    if (/encoder|libx264|codec|pixel format/.test(value))
        return "encoder";
    if (/option|unrecognized|invalid argument|filter|scale/.test(value))
        return "option";
    return "other";
}
class LinuxCapture {
    geometry;
    display;
    ffmpeg;
    frameFormat;
    writer;
    onFailure;
    child;
    stopping = false;
    startedAt = performance.now();
    restartPromise = Promise.resolve();
    frameDiagnosticSent = false;
    constructor(geometry, display, ffmpeg, frameFormat, writer, onFailure) {
        this.geometry = geometry;
        this.display = display;
        this.ffmpeg = ffmpeg;
        this.frameFormat = frameFormat;
        this.writer = writer;
        this.onFailure = onFailure;
    }
    start() {
        this.stopping = false;
        this.spawnEncoder();
    }
    requestIDR() {
        if (this.stopping)
            return;
        this.restartPromise = this.restartPromise.then(async () => {
            const current = this.child;
            if (current && current.exitCode === null) {
                // Fence this encoder generation before intentionally terminating it. The exit listener
                // treats only the currently-owned encoder as an unexpected capture failure.
                if (this.child === current)
                    this.child = undefined;
                current.kill("SIGTERM");
                await Promise.race([once(current, "exit").catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 300))]);
                if (current.exitCode === null)
                    current.kill("SIGKILL");
            }
            if (!this.stopping)
                this.spawnEncoder();
        });
    }
    async stop() {
        this.stopping = true;
        await this.restartPromise;
        const current = this.child;
        this.child = undefined;
        if (current && current.exitCode === null) {
            current.kill("SIGTERM");
            await Promise.race([once(current, "exit").catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 500))]);
            if (current.exitCode === null)
                current.kill("SIGKILL");
        }
    }
    spawnEncoder() {
        const output = scaledVideoSize(this.geometry.width, this.geometry.height);
        const captureArgs = [
            "-hide_banner", "-loglevel", "error",
            "-f", "x11grab", "-framerate", String(DEFAULT_FPS), "-draw_mouse", "0",
            "-window_id", String(this.geometry.windowId), "-i", this.display,
            "-an", "-vf", `scale=${output.width}:${output.height}`
        ];
        const args = this.frameFormat === "jpeg"
            ? [...captureArgs, "-c:v", "mjpeg", "-q:v", "5", "-f", "image2pipe", "pipe:1"]
            : [
                ...captureArgs,
                "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
                "-profile:v", "baseline", "-pix_fmt", "yuv420p",
                "-g", String(DEFAULT_FPS), "-keyint_min", String(DEFAULT_FPS), "-sc_threshold", "0",
                "-x264-params", `aud=1:repeat-headers=1:keyint=${DEFAULT_FPS}:min-keyint=${DEFAULT_FPS}:scenecut=0`,
                "-b:v", "1600k", "-maxrate", "2000k", "-bufsize", "2000k",
                "-f", "h264", "pipe:1"
            ];
        const child = spawn(this.ffmpeg, args, { env: boundedEnvironment(this.display), stdio: ["ignore", "pipe", "pipe"] });
        this.child = child;
        process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=capture_started\n");
        const frameReady = () => {
            if (this.frameDiagnosticSent)
                return;
            this.frameDiagnosticSent = true;
            process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=frame_ready\n");
        };
        const parser = this.frameFormat === "jpeg"
            ? new JpegFrameParser((jpeg) => {
                frameReady();
                this.writer.submit(jpegFrameRecord(jpeg, output.width, output.height));
            })
            : new AnnexBAccessUnitParser((units, keyframe) => {
                frameReady();
                const timestamp = Math.max(0, Math.floor((performance.now() - this.startedAt) * 90)) >>> 0;
                this.writer.submit(frameRecord(avccFromNalUnits(units), timestamp, keyframe, output.width, output.height));
            });
        child.stdout.on("data", (chunk) => parser.push(chunk));
        child.stdout.once("end", () => parser.end());
        let ffmpegDiagnostic = "";
        child.stderr.on("data", (chunk) => {
            if (ffmpegDiagnostic.length < 4_096)
                ffmpegDiagnostic += chunk.toString("utf8").slice(0, 4_096 - ffmpegDiagnostic.length);
        }); // Classified locally only; raw ffmpeg stderr is never forwarded northbound.
        child.once("error", () => {
            if (!this.stopping) {
                process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=capture_failure_other\n");
                this.onFailure();
            }
        });
        child.once("exit", (code) => {
            if (!this.stopping && this.child === child && code !== 0) {
                const category = classifyFfmpegFailure(ffmpegDiagnostic);
                process.stderr.write(`MCP_HANDOFF_DIAGNOSTIC linux_stage=capture_failure_${category}\n`);
                this.onFailure();
            }
        });
    }
}
function absoluteTool(name, envName) {
    const configured = process.env[envName]?.trim();
    if (configured) {
        if (!configured.startsWith("/"))
            throw new Error(`${envName} must be an absolute path`);
        return configured;
    }
    return `/usr/bin/${name}`;
}
export async function linuxWebRtcHostMain() {
    if (process.env.TAKEOVER_WEBRTC_WINDOW_LINEAGE !== undefined
        || process.env.TAKEOVER_WEBRTC_WINDOW_LINEAGE_TRANSITION_MS !== undefined) {
        throw new Error("successor-window lineage is not supported by the Linux WebRTC host");
    }
    if (process.platform !== "linux")
        throw new Error("Linux WebRTC host is available only on Linux");
    const targetPid = Number(process.env.TAKEOVER_WEBRTC_TARGET_PID);
    const targetWindowId = parseOptionalTargetWindowId(process.env.TAKEOVER_WEBRTC_TARGET_WINDOW_ID);
    const expiresAt = Number(process.env.TAKEOVER_WEBRTC_EXPIRES_AT_UNIX_MS);
    const display = process.env.TAKEOVER_WEBRTC_DISPLAY_NAME?.trim();
    const frameFormatValue = process.env.TAKEOVER_WEBRTC_FRAME_FORMAT?.trim();
    const frameFormat = frameFormatValue === undefined || frameFormatValue === ""
        ? "h264"
        : frameFormatValue === "jpeg"
            ? "jpeg"
            : (() => { throw new Error("TAKEOVER_WEBRTC_FRAME_FORMAT is invalid"); })();
    if (!Number.isSafeInteger(targetPid) || targetPid <= 0) {
        process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=target_missing\n");
        throw new Error("TAKEOVER_WEBRTC_TARGET_PID is required");
    }
    try {
        process.kill(targetPid, 0);
        process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=target_alive\n");
    }
    catch {
        process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=target_missing\n");
        throw new Error("TAKEOVER_WEBRTC_TARGET_PID is unavailable");
    }
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())
        throw new Error("TAKEOVER_WEBRTC_EXPIRES_AT_UNIX_MS is invalid or expired");
    if (!display || !/^:\d+(?:\.\d+)?$/.test(display))
        throw new Error("TAKEOVER_WEBRTC_DISPLAY_NAME must be a local X11 display such as :99");
    const xdotool = absoluteTool("xdotool", "TAKEOVER_LINUX_XDOTOOL");
    const ffmpeg = absoluteTool("ffmpeg", "TAKEOVER_LINUX_FFMPEG");
    const xtestHelperExecutable = packagedLinuxXTestHelper(import.meta.url);
    const atspiHelperExecutable = packagedLinuxAtSpiEditableHelper(import.meta.url);
    let geometry;
    try {
        geometry = await resolveExactWindow(targetPid, targetWindowId, display, xdotool);
    }
    catch (error) {
        const multiple = error instanceof Error && /did not converge/.test(error.message);
        process.stderr.write(`MCP_HANDOFF_DIAGNOSTIC linux_stage=${multiple ? "window_failure_multiple" : "window_failure_none"}\n`);
        throw error;
    }
    process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=window_ready\n");
    let pointer;
    try {
        pointer = await LinuxXTestPointerHelper.start(xtestHelperExecutable, display);
        // Keep the existing bounded diagnostic stage name for operator compatibility. The helper now
        // owns pointer mutations plus the narrowly admitted Return/Backspace XTEST press/release pair.
        process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=input_pointer_helper_ready\n");
    }
    catch (error) {
        process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=input_pointer_helper_failure\n");
        throw error;
    }
    const input = new LinuxWindowInput(geometry, targetPid, display, xdotool, pointer);
    const writer = new LatestFrameWriter();
    let editableHelper;
    try {
        editableHelper = await LinuxAtSpiEditableHelper.start(atspiHelperExecutable, targetPid, geometry, display);
        process.stderr.write(`MCP_HANDOFF_DIAGNOSTIC linux_stage=${editableHelper ? "editable_helper_ready" : "editable_helper_unavailable"}\n`);
    }
    catch {
        process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=editable_helper_unavailable\n");
    }
    let stopped = false;
    let stopHost;
    const capture = new LinuxCapture(geometry, display, ffmpeg, frameFormat, writer, () => {
        process.exitCode = 1;
        void stopHost("capture_failure").catch(() => { process.exitCode = 1; });
    });
    let accessibilityChain = Promise.resolve(undefined);
    const requestAccessibilitySnapshot = () => {
        const helper = editableHelper;
        if (!helper)
            return Promise.resolve(undefined);
        const requested = accessibilityChain
            .catch(() => undefined)
            .then(() => helper.snapshot());
        accessibilityChain = requested.catch(() => {
            editableHelper = undefined;
            process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=editable_helper_unavailable\n");
            void helper.close().catch(() => undefined);
            return undefined;
        });
        return accessibilityChain;
    };
    const publishEditableRegions = async () => {
        const snapshot = await requestAccessibilitySnapshot();
        process.stderr.write(editableRegionsControlLine(snapshot?.regions ?? []));
    };
    const publishFocusedEditable = async () => {
        let editable = false;
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const snapshot = await requestAccessibilitySnapshot();
            if (snapshot) {
                process.stderr.write(editableRegionsControlLine(snapshot.regions));
                if (snapshot.focusEditable) {
                    editable = true;
                    break;
                }
            }
            if (attempt < 4)
                await new Promise((resolve) => setTimeout(resolve, 20));
        }
        writer.submitControl(editableRecord(editable));
    };
    let accessibilityPollBusy = false;
    const accessibilityPoll = setInterval(() => {
        if (stopped || accessibilityPollBusy)
            return;
        accessibilityPollBusy = true;
        void publishEditableRegions()
            .catch(() => undefined)
            .finally(() => { accessibilityPollBusy = false; });
    }, 250);
    accessibilityPoll.unref();
    void publishEditableRegions().catch(() => undefined);
    let pending = Buffer.alloc(0);
    let inputChain = Promise.resolve();
    let stopPromise;
    stopHost = (reason) => {
        if (stopPromise)
            return stopPromise;
        process.stderr.write(`MCP_HANDOFF_DIAGNOSTIC linux_stage=host_stop_${reason}\n`);
        stopped = true;
        // Serialize lifecycle cleanup after every already-admitted Human mutation. If shutdown races
        // an in-flight XTEST press, releasing outside the chain can observe stale helper-owned state
        // and leave a Button1 or special key pressed after helper exit.
        clearInterval(accessibilityPoll);
        inputChain = inputChain
            .then(() => input.shutdown())
            .catch(() => pointer.close());
        stopPromise = inputChain.then(async () => {
            await Promise.all([capture.stop(), editableHelper?.close() ?? Promise.resolve()]);
        });
        return stopPromise;
    };
    capture.start();
    const expiry = setTimeout(() => { void stopHost("expiry").catch(() => { process.exitCode = 1; }); }, Math.max(0, expiresAt - Date.now()));
    process.stdin.on("data", (chunk) => {
        if (stopped)
            return;
        pending = pending.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
        if (pending.byteLength > MAX_PENDING_INPUT_BYTES) {
            void stopHost("input_buffer_bounds").catch(() => { process.exitCode = 1; });
            return;
        }
        for (;;) {
            const newline = pending.indexOf(0x0a);
            if (newline < 0)
                break;
            const line = pending.subarray(0, newline);
            pending = pending.subarray(newline + 1);
            if (line.byteLength < 1 || line.byteLength > MAX_INPUT_LINE_BYTES)
                continue;
            let value;
            try {
                value = JSON.parse(line.toString("utf8"));
            }
            catch {
                continue;
            }
            const command = parseHostInput(value);
            if (!command)
                continue;
            if (command.kind === "stop") {
                void stopHost("explicit_stop").catch(() => { process.exitCode = 1; });
                continue;
            }
            if (command.kind === "requestIDR") {
                capture.requestIDR();
                continue;
            }
            inputChain = inputChain
                .then(() => input.apply(command))
                .then(async () => {
                if (command.kind === "tap" || (command.kind === "pointer_button" && command.state === "up")) {
                    await publishFocusedEditable();
                }
                process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=input_applied\n");
            })
                .catch(() => {
                const failureStage = input.inputFailureDiagnosticStage();
                if (failureStage) {
                    process.stderr.write(`MCP_HANDOFF_DIAGNOSTIC linux_stage=${failureStage}\n`);
                }
                process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=input_failure\n");
                void stopHost("input_failure").catch(() => { process.exitCode = 1; });
            });
        }
    });
    process.stdin.once("end", () => { void stopHost("stdin_end").catch(() => { process.exitCode = 1; }); });
    process.once("SIGTERM", () => { void stopHost("signal_term").catch(() => { process.exitCode = 1; }); });
    process.once("SIGINT", () => { void stopHost("signal_int").catch(() => { process.exitCode = 1; }); });
    while (!stopped)
        await new Promise((resolve) => setTimeout(resolve, 40));
    clearTimeout(expiry);
    await stopPromise;
}
function classifyLinuxHostCrashMessage(error) {
    const message = error instanceof Error ? error.message : "";
    if (/input focus is not owned/.test(message))
        return "focus_not_owned";
    if (/window did not become active/.test(message))
        return "window_not_active";
    if (/target process is unavailable/.test(message))
        return "target_process_unavailable";
    if (/window is no longer visible/.test(message))
        return "window_not_visible";
    if (/window ownership changed/.test(message))
        return "window_owner_changed";
    if (/window geometry is unavailable/.test(message))
        return "window_geometry_unavailable";
    if (/geometry changed during special key press/.test(message))
        return "special_key_geometry_changed";
    if (/XTEST input helper is unavailable/.test(message))
        return "xtest_helper_unavailable";
    if (/XTEST input helper is busy/.test(message))
        return "xtest_helper_busy";
    if (/XTEST input helper acknowledgement timed out/.test(message))
        return "xtest_helper_ack_timeout";
    if (/XTEST input helper rejected a command/.test(message))
        return "xtest_helper_rejected";
    if (/AT-SPI editable helper is unavailable/.test(message))
        return "atspi_unavailable";
    if (/AT-SPI editable helper is busy/.test(message))
        return "atspi_busy";
    if (/AT-SPI editable helper snapshot timed out/.test(message))
        return "atspi_timeout";
    if (/AT-SPI editable helper readiness timed out/.test(message))
        return "atspi_readiness_timeout";
    if (/AT-SPI editable helper response failed/.test(message))
        return "atspi_response_failed";
    if (/AT-SPI editable helper response is invalid/.test(message))
        return "atspi_response_invalid";
    if (/AT-SPI editable helper response is too large/.test(message))
        return "atspi_response_large";
    if (/AT-SPI editable helper returned too many regions/.test(message))
        return "atspi_regions_many";
    if (/AT-SPI editable helper region is invalid/.test(message))
        return "atspi_region_invalid";
    if (/AT-SPI editable helper region is out of bounds/.test(message))
        return "atspi_region_bounds";
    if (/AT-SPI editable helper write failed/.test(message))
        return "atspi_write_failure";
    if (/AT-SPI editable helper output exceeded limit/.test(message))
        return "atspi_output_bounds";
    if (/AT-SPI editable helper protocol mismatch/.test(message))
        return "atspi_protocol_mismatch";
    if (/AT-SPI editable helper emitted an unexpected response/.test(message))
        return "atspi_unexpected_response";
    if (/AT-SPI editable helper failed/.test(message))
        return "atspi_process_failed";
    if (/AT-SPI editable helper closed/.test(message))
        return "atspi_process_closed";
    if (/AT-SPI editable helper/.test(message))
        return "atspi_failed";
    if (/host helper command timed out/.test(message))
        return "helper_command_timeout";
    if (/host helper command failed/.test(message))
        return "helper_command_failed";
    return "other";
}
function classifyLinuxHostCrash(error) {
    const code = error && typeof error === "object" && "code" in error
        ? String(error.code ?? "")
        : "";
    if (code === "EPIPE")
        return "pipe_epipe";
    if (code === "ERR_STREAM_WRITE_AFTER_END")
        return "stream_write_after_end";
    if (code === "ERR_STREAM_DESTROYED")
        return "stream_destroyed";
    const message = error instanceof Error ? error.message : "";
    const stack = error instanceof Error ? error.stack ?? "" : "";
    if (/Linux WebSocket host JPEG/.test(message) || /JpegFrameParser/.test(stack))
        return "jpeg_parser";
    if (/LatestFrameWriter/.test(stack))
        return "frame_writer";
    if (/LinuxWindowInput\.pressSpecialKey|pressSpecialKey/.test(stack))
        return "special_key";
    if (/LinuxWindowInput\.currentOwnedGeometry|currentOwnedGeometry/.test(stack))
        return "exact_window_revalidate";
    if (/LinuxWindowInput\.confirmActiveTarget|confirmActiveTarget|activeTargetOnce/.test(stack))
        return "active_target_check";
    if (/LinuxWindowInput\.confirmInputFocusOwnedByTarget|confirmInputFocusOwnedByTarget|inputFocusOwnedByTargetOnce/.test(stack))
        return "focus_target_check";
    if (/LinuxWindowInput\.scrollAxis|scrollAxis/.test(stack))
        return "scroll_input";
    if (/LinuxWindowInput\.typeText|typeText/.test(stack))
        return "text_input";
    if (/LinuxWindowInput\.apply|\.apply \(/.test(stack))
        return "host_input_apply";
    if (/inputChain/.test(stack))
        return "host_input_chain";
    if (/LinuxWindowInput/.test(stack))
        return "input_callback";
    if (/LinuxXTestPointerHelper/.test(stack))
        return "xtest_callback";
    if (/LinuxAtSpiEditableHelper|publishEditable/.test(stack))
        return "accessibility_callback";
    if (/LinuxCapture/.test(stack))
        return "capture_callback";
    if (/node:internal\/streams|node:stream/.test(stack))
        return "stream_internal";
    if (/node:events/.test(stack))
        return "event_dispatch";
    if (/node:internal\/child_process|node:child_process/.test(stack))
        return "child_process_internal";
    if (/linux-webrtc-host-cli\.(?:js|ts)/.test(stack))
        return "host_module";
    return "unknown";
}
function classifyLinuxHostCrashOrigin(origin) {
    if (origin === "uncaughtException")
        return "uncaught_exception";
    if (origin === "unhandledRejection")
        return "unhandled_rejection";
    return "unknown";
}
function classifyLinuxHostCrashErrorKind(error) {
    if (error instanceof TypeError)
        return "type_error";
    if (error instanceof RangeError)
        return "range_error";
    if (error instanceof Error)
        return "error";
    return "other";
}
export function isLinuxWebRtcHostCliEntryPoint(moduleUrl, argvPath) {
    if (!argvPath)
        return false;
    try {
        return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
    }
    catch {
        return false;
    }
}
if (isLinuxWebRtcHostCliEntryPoint(import.meta.url, process.argv[1])) {
    let crashDiagnosticEmitted = false;
    process.on("uncaughtExceptionMonitor", (error, origin) => {
        if (crashDiagnosticEmitted)
            return;
        crashDiagnosticEmitted = true;
        process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=host_crash_uncaught_exception\n");
        process.stderr.write(`MCP_HANDOFF_DIAGNOSTIC linux_stage=host_crash_origin_${classifyLinuxHostCrashOrigin(origin)}\n`);
        process.stderr.write(`MCP_HANDOFF_DIAGNOSTIC linux_stage=host_crash_error_${classifyLinuxHostCrashErrorKind(error)}\n`);
        process.stderr.write(`MCP_HANDOFF_DIAGNOSTIC linux_stage=host_crash_message_${classifyLinuxHostCrashMessage(error)}\n`);
        process.stderr.write(`MCP_HANDOFF_DIAGNOSTIC linux_stage=host_crash_class_${classifyLinuxHostCrash(error)}\n`);
    });
    linuxWebRtcHostMain().catch(() => {
        if (!crashDiagnosticEmitted) {
            crashDiagnosticEmitted = true;
            process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=host_crash_main_rejection\n");
        }
        process.exitCode = 1;
    });
}
//# sourceMappingURL=linux-webrtc-host-cli.js.map