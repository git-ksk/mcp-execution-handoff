import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { TakeoverHostTarget } from "../browser-takeover/broker.js";
import { parseWindowGeometry, parseWindowIds } from "../browser-takeover/linux-webrtc-host-cli.js";
import type { ExperimentalWebSocketWindowSurface } from "./websocket-window-handoff.js";
import type { WebSocketTakeoverFrame } from "./websocket-takeover.js";

const MAX_HOST_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_DIAGNOSTIC_BUFFER_BYTES = 8 * 1024;
const FRAME_WAIT_TIMEOUT_MS = 4_000;
const INPUT_ACK_TIMEOUT_MS = 4_000;
const HELPER_STOP_TIMEOUT_MS = 1_000;

export type LinuxWebSocketSurfaceFailure =
  | "none"
  | "frame_timeout"
  | "helper_closed"
  | "helper_error"
  | "frame_protocol"
  | "diagnostics_bounds"
  | "input_failure"
  | "revalidation_failure"
  | "capture_x11"
  | "capture_encoder"
  | "capture_option"
  | "capture_other";

export interface ExperimentalLinuxWebSocketWindowSurfaceConfig {
  hostScript: string;
  displayName: string;
  xdotoolExecutable?: string;
  helperTtlMs?: number;
}

export interface LinuxWebSocketJpegFrame {
  data: Buffer;
  width: number;
  height: number;
}

/** Parses private JPEG records while accepting the helper's bounded editable-focus control record. */
export class LinuxWebSocketHostRecordParser {
  #pending = Buffer.alloc(0);

  constructor(private readonly onFrame: (frame: LinuxWebSocketJpegFrame) => void) {}

  push(chunk: Buffer): void {
    if (chunk.byteLength === 0) return;
    this.#pending = this.#pending.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([this.#pending, chunk]);
    if (this.#pending.byteLength > MAX_HOST_RECORD_BYTES + 5) {
      throw new Error("Linux WSS host record buffer exceeded bounds");
    }
    for (;;) {
      if (this.#pending.byteLength < 5) return;
      const type = this.#pending[0];
      const length = this.#pending.readUInt32BE(1);
      if (type !== 2 || length < 1 || length > MAX_HOST_RECORD_BYTES) {
        throw new Error("Linux WSS host emitted an invalid record");
      }
      if (this.#pending.byteLength < 5 + length) return;
      const payload = this.#pending.subarray(5, 5 + length);
      this.#pending = this.#pending.subarray(5 + length);
      if (length === 1) {
        if (payload[0] !== 0 && payload[0] !== 1) {
          throw new Error("Linux WSS host emitted an invalid editable-focus record");
        }
        continue;
      }
      if (length < 8) throw new Error("Linux WSS host emitted an invalid record");
      const width = payload.readUInt16BE(0);
      const height = payload.readUInt16BE(2);
      const data = payload.subarray(4);
      if (
        width < 1
        || height < 1
        || data.byteLength < 4
        || data[0] !== 0xff
        || data[1] !== 0xd8
        || data[data.byteLength - 2] !== 0xff
        || data[data.byteLength - 1] !== 0xd9
      ) {
        throw new Error("Linux WSS host emitted an invalid JPEG frame");
      }
      this.onFrame({ data: Buffer.from(data), width, height });
    }
  }
}

interface ActiveLinuxSurface {
  target: Readonly<TakeoverHostTarget>;
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  latest?: LinuxWebSocketJpegFrame;
  sequence: number;
  failed: boolean;
  frameWaiters: Array<{
    afterSequence: number;
    resolve: (frame: LinuxWebSocketJpegFrame) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>;
  stderrBuffer: string;
  pendingInputAck: {
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  } | undefined;
  inputChain: Promise<void>;
}

/**
 * Private Linux physical-Acceptance surface for the #40 WSS experiment.
 *
 * It deliberately reuses the existing normal-browser exact-window helper. The helper still owns
 * X11 target resolution, capture and Human input. This adapter selects its JPEG-only stdout mode,
 * keeps the process/window tuple server-side, revalidates that exact tuple before every returned
 * frame/input, and never exposes helper transport details to Browser/Window consumers.
 */
export class ExperimentalLinuxWebSocketWindowSurface implements ExperimentalWebSocketWindowSurface {
  readonly #hostScript: string;
  readonly #displayName: string;
  readonly #xdotoolExecutable: string;
  readonly #helperTtlMs: number;
  #active: ActiveLinuxSurface | undefined;
  #transition: Promise<void> | undefined;
  #lastFailure: LinuxWebSocketSurfaceFailure = "none";
  #framesObserved = 0;

  constructor(config: ExperimentalLinuxWebSocketWindowSurfaceConfig) {
    if (!config.hostScript.trim() || !isAbsolute(config.hostScript)) {
      throw new Error("Linux WSS host script must be an absolute path");
    }
    if (!/^:\d+(?:\.\d+)?$/.test(config.displayName)) {
      throw new Error("Linux WSS display name must be a local X11 display such as :99");
    }
    const xdotoolExecutable = config.xdotoolExecutable ?? "/usr/bin/xdotool";
    if (!isAbsolute(xdotoolExecutable)) throw new Error("Linux WSS xdotool executable must be absolute");
    const helperTtlMs = config.helperTtlMs ?? 15 * 60_000;
    if (!Number.isSafeInteger(helperTtlMs) || helperTtlMs < 30_000 || helperTtlMs > 60 * 60_000) {
      throw new Error("Linux WSS helper ttl is invalid");
    }
    this.#hostScript = config.hostScript;
    this.#displayName = config.displayName;
    this.#xdotoolExecutable = xdotoolExecutable;
    this.#helperTtlMs = helperTtlMs;
  }

  diagnosticsSnapshot(): { lastFailure: LinuxWebSocketSurfaceFailure; framesObserved: number } {
    return {
      lastFailure: this.#lastFailure,
      framesObserved: Math.min(this.#framesObserved, 1_000_000)
    };
  }

  async captureExactWindow(target: Readonly<TakeoverHostTarget>): Promise<WebSocketTakeoverFrame> {
    const active = await this.#ensure(target);
    const before = active.sequence;
    try {
      await this.#revalidate(target);
    } catch (error) {
      this.#lastFailure = "revalidation_failure";
      throw error;
    }
    let frame: LinuxWebSocketJpegFrame;
    try {
      frame = await this.#frameAfter(active, before);
    } catch (error) {
      if (error instanceof Error && error.message.includes("frame timed out")) {
        this.#lastFailure = "frame_timeout";
      }
      throw error;
    }
    return {
      data: Buffer.from(frame.data),
      width: frame.width,
      height: frame.height,
      mimeType: "image/jpeg"
    };
  }

  tapExactWindow(target: Readonly<TakeoverHostTarget>, x: number, y: number): Promise<void> {
    return this.#input(target, { kind: "tap", x, y });
  }

  scrollExactWindow(target: Readonly<TakeoverHostTarget>, deltaY: number): Promise<void> {
    return this.#input(target, { kind: "scroll", deltaX: 0, deltaY });
  }

  insertExactWindowText(target: Readonly<TakeoverHostTarget>, text: string): Promise<void> {
    return this.#input(target, { kind: "text", text });
  }

  pressExactWindowKey(target: Readonly<TakeoverHostTarget>, key: string): Promise<void> {
    if (key !== "Backspace" && key !== "Enter") return Promise.reject(new Error("Linux WSS key is unsupported"));
    return this.#input(target, { kind: "key", key });
  }

  async close(): Promise<void> {
    if (this.#transition) await this.#transition.catch(() => undefined);
    const active = this.#active;
    this.#active = undefined;
    if (active) await stopActive(active);
  }

  async #input(target: Readonly<TakeoverHostTarget>, input: Record<string, unknown>): Promise<void> {
    const active = await this.#ensure(target);
    active.inputChain = active.inputChain.then(async () => {
      if (active.failed || this.#active !== active) throw new Error("Linux WSS exact-window helper is unavailable");
      await this.#revalidate(target);
      if (active.pendingInputAck) throw new Error("Linux WSS exact-window helper input is busy");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (active.pendingInputAck?.timer !== timer) return;
          active.pendingInputAck = undefined;
          reject(new Error("Linux WSS exact-window helper input acknowledgement timed out"));
          failActive(active, "Linux WSS exact-window helper input acknowledgement timed out");
        }, INPUT_ACK_TIMEOUT_MS);
        active.pendingInputAck = { resolve, reject, timer };
        const line = `${JSON.stringify(input)}\n`;
        if (!active.child.stdin.write(line)) {
          active.child.stdin.once("drain", () => undefined);
        }
      });
    });
    return active.inputChain;
  }

  async #ensure(target: Readonly<TakeoverHostTarget>): Promise<ActiveLinuxSurface> {
    validateExactTarget(target);
    const active = this.#active;
    if (active && !active.failed && sameTarget(active.target, target)) return active;
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

  async #replace(target: Readonly<TakeoverHostTarget>): Promise<void> {
    const previous = this.#active;
    this.#active = undefined;
    if (previous) await stopActive(previous);
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
    const state: ActiveLinuxSurface = {
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
      if (state.failed) return;
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
    child.stdout.on("data", (chunk: Buffer) => {
      try { parser.push(chunk); } catch {
        this.#lastFailure = "frame_protocol";
        failActive(state, "Linux WSS exact-window helper frame protocol failed");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => consumeDiagnostics(state, chunk, (stage) => {
      const category = captureFailureCategory(stage);
      if (category) this.#lastFailure = category;
      else if (stage === "input_failure") this.#lastFailure = "input_failure";
    }));
    child.once("error", () => {
      if (this.#lastFailure === "none") this.#lastFailure = "helper_error";
      failActive(state, "Linux WSS exact-window helper failed");
    });
    child.once("close", () => {
      if (this.#lastFailure === "none") this.#lastFailure = "helper_closed";
      failActive(state, "Linux WSS exact-window helper closed");
    });
    this.#active = state;
    await this.#frameAfter(state, 0);
  }

  async #frameAfter(active: ActiveLinuxSurface, afterSequence: number): Promise<LinuxWebSocketJpegFrame> {
    if (active.failed || this.#active !== active) throw new Error("Linux WSS exact-window helper is unavailable");
    if (active.latest && active.sequence > afterSequence) return active.latest;
    return await new Promise<LinuxWebSocketJpegFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        active.frameWaiters = active.frameWaiters.filter((waiter) => waiter.timer !== timer);
        reject(new Error("Linux WSS exact-window frame timed out"));
      }, FRAME_WAIT_TIMEOUT_MS);
      active.frameWaiters.push({ afterSequence, resolve, reject, timer });
    });
  }

  async #revalidate(target: Readonly<TakeoverHostTarget>): Promise<void> {
    validateExactTarget(target);
    try { process.kill(target.processId, 0); } catch { throw new Error("Linux WSS target process is unavailable"); }
    const env = { DISPLAY: this.#displayName, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
    const visible = parseWindowIds(await runBounded(this.#xdotoolExecutable, [
      "search", "--onlyvisible", "--pid", String(target.processId)
    ], env).catch(() => ""));
    if (!visible.includes(target.windowId!)) throw new Error("Linux WSS target window is no longer visible");
    const owner = Number((await runBounded(this.#xdotoolExecutable, [
      "getwindowpid", String(target.windowId)
    ], env).catch(() => "")).trim());
    if (owner !== target.processId) throw new Error("Linux WSS target window ownership changed");
    const geometry = parseWindowGeometry(await runBounded(this.#xdotoolExecutable, [
      "getwindowgeometry", "--shell", String(target.windowId)
    ], env).catch(() => ""), target.windowId!);
    if (!geometry) throw new Error("Linux WSS target window geometry is unavailable");
  }
}

function validateExactTarget(target: Readonly<TakeoverHostTarget>): void {
  if (!Number.isSafeInteger(target.processId) || target.processId <= 0) {
    throw new Error("Linux WSS surface requires a positive target process id");
  }
  if (!Number.isSafeInteger(target.windowId) || target.windowId! <= 0) {
    throw new Error("Linux WSS physical surface requires an explicit positive target window id");
  }
}

function sameTarget(left: Readonly<TakeoverHostTarget>, right: Readonly<TakeoverHostTarget>): boolean {
  return left.processId === right.processId && left.windowId === right.windowId;
}

function consumeDiagnostics(
  active: ActiveLinuxSurface,
  chunk: Buffer,
  onStage: (stage: string) => void
): void {
  if (active.failed) return;
  active.stderrBuffer += chunk.toString("utf8");
  if (active.stderrBuffer.length > MAX_DIAGNOSTIC_BUFFER_BYTES) {
    onStage("diagnostics_bounds");
    failActive(active, "Linux WSS exact-window helper diagnostics exceeded bounds");
    return;
  }
  for (;;) {
    const newline = active.stderrBuffer.indexOf("\n");
    if (newline < 0) return;
    const line = active.stderrBuffer.slice(0, newline).trim();
    active.stderrBuffer = active.stderrBuffer.slice(newline + 1);
    const match = /^MCP_HANDOFF_DIAGNOSTIC linux_stage=([a-z0-9_]{1,64})$/.exec(line);
    if (!match) continue;
    onStage(match[1]!);
    if (match[1] === "input_applied") {
      const pending = active.pendingInputAck;
      if (!pending) continue;
      active.pendingInputAck = undefined;
      clearTimeout(pending.timer);
      pending.resolve();
    } else if (match[1] === "input_failure") {
      failActive(active, "Linux WSS exact-window helper input failed");
    }
  }
}

function captureFailureCategory(stage: string): LinuxWebSocketSurfaceFailure | undefined {
  if (stage === "capture_failure_x11") return "capture_x11";
  if (stage === "capture_failure_encoder") return "capture_encoder";
  if (stage === "capture_failure_option") return "capture_option";
  if (stage === "capture_failure_other") return "capture_other";
  if (stage === "diagnostics_bounds") return "diagnostics_bounds";
  return undefined;
}

function failActive(active: ActiveLinuxSurface, message: string): void {
  if (active.failed) return;
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
  if (active.child.exitCode === null && active.child.signalCode === null) active.child.kill("SIGTERM");
}

async function stopActive(active: ActiveLinuxSurface): Promise<void> {
  if (active.child.exitCode !== null || active.child.signalCode !== null) return;
  try { active.child.stdin.write('{"kind":"stop"}\n'); } catch {}
  active.child.stdin.end();
  const ended = await Promise.race([
    once(active.child, "close").then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), HELPER_STOP_TIMEOUT_MS))
  ]);
  if (ended || active.child.exitCode !== null || active.child.signalCode !== null) return;
  active.child.kill("SIGTERM");
  await Promise.race([
    once(active.child, "close").catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 250))
  ]);
  if (active.child.exitCode === null && active.child.signalCode === null) active.child.kill("SIGKILL");
}

async function runBounded(executable: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const child = spawn(executable, args, { env, stdio: ["ignore", "pipe", "ignore"] });
  const chunks: Buffer[] = [];
  let bytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes <= 64 * 1024) chunks.push(chunk);
  });
  child.once("error", () => undefined);
  const [code] = await once(child, "close") as [number | null, NodeJS.Signals | null];
  if (code !== 0 || bytes > 64 * 1024) throw new Error("Linux WSS exact-window query failed");
  return Buffer.concat(chunks).toString("utf8");
}
