#!/usr/bin/env node
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const MAX_HOST_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_LINE_BYTES = 4 * 1024;
const MAX_PENDING_INPUT_BYTES = 8 * 1024;
const DEFAULT_FPS = 15;
const DEFAULT_MAX_WIDTH = 1280;
const DEFAULT_MAX_HEIGHT = 720;
const MIN_WINDOW_WIDTH = 160;
const MIN_WINDOW_HEIGHT = 120;

export interface LinuxWindowGeometry {
  windowId: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LinuxHostInput {
  kind: "tap" | "scroll" | "text" | "key";
  x?: number;
  y?: number;
  deltaX?: number;
  deltaY?: number;
  text?: string;
  key?: "Backspace" | "Enter";
}

export function parseWindowIds(value: string): number[] {
  const ids = value.split(/\s+/).filter(Boolean).map((item) => Number(item));
  return ids.filter((item) => Number.isSafeInteger(item) && item > 0);
}

export function parseWindowGeometry(value: string, expectedWindowId: number): LinuxWindowGeometry | undefined {
  const fields = new Map<string, number>();
  for (const line of value.split(/\r?\n/)) {
    const match = /^([A-Z]+)=(-?\d+)$/.exec(line.trim());
    if (match) fields.set(match[1]!, Number(match[2]));
  }
  const windowId = fields.get("WINDOW") ?? expectedWindowId;
  const x = fields.get("X");
  const y = fields.get("Y");
  const width = fields.get("WIDTH");
  const height = fields.get("HEIGHT");
  if (![windowId, x, y, width, height].every(Number.isSafeInteger)) return undefined;
  if (windowId !== expectedWindowId || width! < MIN_WINDOW_WIDTH || height! < MIN_WINDOW_HEIGHT) return undefined;
  return { windowId, x: x!, y: y!, width: width!, height: height! };
}

export function scaledVideoSize(width: number, height: number): { width: number; height: number } {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || height < 2) {
    throw new Error("Linux WebRTC host received invalid window geometry");
  }
  const scale = Math.min(1, DEFAULT_MAX_WIDTH / width, DEFAULT_MAX_HEIGHT / height);
  const even = (value: number) => {
    const rounded = Math.max(2, Math.floor(value));
    return rounded % 2 === 0 ? rounded : rounded - 1;
  };
  return { width: even(width * scale), height: even(height * scale) };
}

export function avccFromNalUnits(units: readonly Buffer[]): Buffer {
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

export function frameRecord(avcc: Buffer, timestamp: number, keyframe: boolean, width: number, height: number): Buffer {
  if (avcc.byteLength < 1 || avcc.byteLength > MAX_HOST_FRAME_BYTES - 9) throw new Error("Linux WebRTC host frame is out of bounds");
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

function startCodeAt(buffer: Buffer, offset: number): number {
  for (let i = offset; i + 3 <= buffer.length; i += 1) {
    if (buffer[i] !== 0 || buffer[i + 1] !== 0) continue;
    if (buffer[i + 2] === 1) return i;
    if (i + 3 < buffer.length && buffer[i + 2] === 0 && buffer[i + 3] === 1) return i;
  }
  return -1;
}

function startCodeLength(buffer: Buffer, offset: number): number {
  return buffer[offset + 2] === 1 ? 3 : 4;
}

/** Splits Annex-B H.264 into access units using mandatory AUD NALs emitted by the Linux encoder. */
export class AnnexBAccessUnitParser {
  private pending = Buffer.alloc(0);
  private current: Buffer[] = [];

  constructor(private readonly emit: (units: Buffer[], keyframe: boolean) => void) {}

  push(chunk: Buffer): void {
    if (chunk.byteLength === 0) return;
    this.pending = this.pending.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([this.pending, chunk]);
    this.drain(false);
  }

  end(): void {
    this.drain(true);
    this.emitCurrent();
    this.pending = Buffer.alloc(0);
  }

  private drain(flush: boolean): void {
    let first = startCodeAt(this.pending, 0);
    if (first < 0) {
      if (this.pending.byteLength > MAX_HOST_FRAME_BYTES) throw new Error("Linux WebRTC host H.264 buffer exceeded bounds");
      return;
    }
    if (first > 0) this.pending = this.pending.subarray(first);
    for (;;) {
      first = startCodeAt(this.pending, 0);
      if (first !== 0) return;
      const header = startCodeLength(this.pending, 0);
      const next = startCodeAt(this.pending, header);
      if (next < 0) {
        if (!flush) return;
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

  private acceptNal(nal: Buffer): void {
    if (nal.byteLength < 1) return;
    const type = nal[0]! & 0x1f;
    if (type === 9) {
      this.emitCurrent();
      return;
    }
    this.current.push(Buffer.from(nal));
    const bytes = this.current.reduce((sum, unit) => sum + unit.byteLength + 4, 0);
    if (bytes > MAX_HOST_FRAME_BYTES - 9) throw new Error("Linux WebRTC host access unit exceeded bounds");
  }

  private emitCurrent(): void {
    if (this.current.length === 0) return;
    const units = this.current;
    this.current = [];
    this.emit(units, units.some((unit) => (unit[0]! & 0x1f) === 5));
  }
}

class LatestFrameWriter {
  private blocked = false;
  private latest: Buffer | undefined;

  submit(record: Buffer): void {
    if (this.blocked) {
      this.latest = record;
      return;
    }
    if (!process.stdout.write(record)) {
      this.blocked = true;
      process.stdout.once("drain", () => this.drain());
    }
  }

  private drain(): void {
    this.blocked = false;
    const latest = this.latest;
    this.latest = undefined;
    if (latest) this.submit(latest);
  }
}

function boundedEnvironment(display: string): NodeJS.ProcessEnv {
  return { DISPLAY: display, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
}

async function runCommand(executable: string, args: string[], display: string): Promise<string> {
  const child = spawn(executable, args, { env: boundedEnvironment(display), stdio: ["ignore", "pipe", "ignore"] });
  const stdout: Buffer[] = [];
  let bytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes <= 64 * 1024) stdout.push(chunk);
  });
  child.once("error", () => undefined);
  const [code] = await once(child, "close") as [number | null, NodeJS.Signals | null];
  if (code !== 0 || bytes > 64 * 1024) throw new Error(`Linux WebRTC host helper command failed: ${executable}`);
  return Buffer.concat(stdout).toString("utf8");
}

async function resolveExactWindow(targetPid: number, display: string, xdotool: string): Promise<LinuxWindowGeometry> {
  const deadline = Date.now() + 7_000;
  while (Date.now() < deadline) {
    const rawIds = await runCommand(xdotool, ["search", "--onlyvisible", "--pid", String(targetPid)], display).catch(() => "");
    const ids = [...new Set(parseWindowIds(rawIds))];
    const candidates: LinuxWindowGeometry[] = [];
    for (const id of ids) {
      const pidText = await runCommand(xdotool, ["getwindowpid", String(id)], display).catch(() => "");
      if (Number(pidText.trim()) !== targetPid) continue;
      const geometry = parseWindowGeometry(
        await runCommand(xdotool, ["getwindowgeometry", "--shell", String(id)], display).catch(() => ""),
        id
      );
      if (geometry) candidates.push(geometry);
    }
    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length > 1) throw new Error("Linux WebRTC host found multiple eligible windows for the target browser PID");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Linux WebRTC host could not resolve exactly one eligible window for the target browser PID");
}

function parseHostInput(value: unknown): LinuxHostInput | { kind: "stop" } | { kind: "requestIDR" } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === "stop" || record.kind === "requestIDR") return { kind: record.kind };
  if (record.kind === "tap") {
    const x = Number(record.x), y = Number(record.y);
    return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { kind: "tap", x, y } : undefined;
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
  if (record.kind === "key" && (record.key === "Backspace" || record.key === "Enter")) return { kind: "key", key: record.key };
  return undefined;
}

class LinuxWindowInput {
  constructor(
    private readonly geometry: LinuxWindowGeometry,
    private readonly display: string,
    private readonly xdotool: string,
    private readonly xclip: string
  ) {}

  async apply(input: LinuxHostInput): Promise<void> {
    // Ask the window manager to activate the exact target first, then confirm X input focus.
    // This mirrors the macOS host's explicit raise/activate boundary and avoids relying on
    // pointer movement alone to make Chromium the active input target.
    await runCommand(this.xdotool, ["windowactivate", "--sync", String(this.geometry.windowId)], this.display);
    await runCommand(this.xdotool, ["windowfocus", "--sync", String(this.geometry.windowId)], this.display);
    process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=input_focus_ready\n");
    if (input.kind === "tap") {
      const localX = Math.max(0, Math.min(this.geometry.width - 1, Math.round(this.geometry.width * input.x!)));
      const localY = Math.max(0, Math.min(this.geometry.height - 1, Math.round(this.geometry.height * input.y!)));
      const x = this.geometry.x + localX;
      const y = this.geometry.y + localY;
      // Move through XTest using root coordinates derived from the exact target window. This avoids
      // reparenting/window-decoration differences in --window-relative pointer semantics while
      // keeping the point strictly inside the already-resolved browser window.
      await runCommand(this.xdotool, ["mousemove", "--sync", String(x), String(y)], this.display);
      await runCommand(this.xdotool, ["click", "1"], this.display);
      process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=input_tap_sent\n");
      return;
    }
    if (input.kind === "scroll") {
      await this.scrollAxis(input.deltaY ?? 0, 4, 5);
      await this.scrollAxis(input.deltaX ?? 0, 6, 7);
      return;
    }
    if (input.kind === "key") {
      const key = input.key === "Backspace" ? "BackSpace" : "Return";
      await runCommand(this.xdotool, ["key", "--window", String(this.geometry.windowId), "--clearmodifiers", key], this.display);
      return;
    }
    await this.pasteText(input.text!);
  }

  private async scrollAxis(delta: number, negativeButton: number, positiveButton: number): Promise<void> {
    if (!delta) return;
    const repeats = Math.max(1, Math.min(12, Math.ceil(Math.abs(delta) / 80)));
    const button = delta < 0 ? negativeButton : positiveButton;
    await runCommand(this.xdotool, ["click", "--window", String(this.geometry.windowId), "--repeat", String(repeats), String(button)], this.display);
  }

  private async pasteText(text: string): Promise<void> {
    const owner = spawn(this.xclip, ["-selection", "clipboard", "-in", "-loops", "1"], {
      env: boundedEnvironment(this.display),
      stdio: ["pipe", "ignore", "ignore"]
    });
    owner.once("error", () => undefined);
    owner.stdin.on("error", () => undefined);
    owner.stdin.end(Buffer.from(text, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 35));
    try {
      await runCommand(this.xdotool, ["key", "--window", String(this.geometry.windowId), "--clearmodifiers", "ctrl+v"], this.display);
      await Promise.race([once(owner, "exit").catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 250))]);
    } finally {
      if (owner.exitCode === null) owner.kill("SIGTERM");
      await this.clearClipboard();
    }
  }

  private async clearClipboard(): Promise<void> {
    const clear = spawn(this.xclip, ["-selection", "clipboard", "-in"], {
      env: boundedEnvironment(this.display),
      stdio: ["pipe", "ignore", "ignore"]
    });
    clear.once("error", () => undefined);
    clear.stdin.on("error", () => undefined);
    clear.stdin.end(Buffer.alloc(0));
    await new Promise((resolve) => setTimeout(resolve, 35));
    if (clear.exitCode === null) clear.kill("SIGTERM");
  }
}

function classifyFfmpegFailure(stderr: string): "x11" | "encoder" | "option" | "other" {
  const value = stderr.toLowerCase();
  if (/x11|display|xcb|cannot open|failed to capture|window/.test(value)) return "x11";
  if (/encoder|libx264|codec|pixel format/.test(value)) return "encoder";
  if (/option|unrecognized|invalid argument|filter|scale/.test(value)) return "option";
  return "other";
}

class LinuxCapture {
  private child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  private stopping = false;
  private startedAt = performance.now();
  private restartPromise = Promise.resolve();
  private frameDiagnosticSent = false;

  constructor(
    private readonly geometry: LinuxWindowGeometry,
    private readonly display: string,
    private readonly ffmpeg: string,
    private readonly writer: LatestFrameWriter,
    private readonly onFailure: () => void
  ) {}

  start(): void {
    this.stopping = false;
    this.spawnEncoder();
  }

  requestIDR(): void {
    if (this.stopping) return;
    this.restartPromise = this.restartPromise.then(async () => {
      const current = this.child;
      if (current && current.exitCode === null) {
        // Fence this encoder generation before intentionally terminating it. The exit listener
        // treats only the currently-owned encoder as an unexpected capture failure.
        if (this.child === current) this.child = undefined;
        current.kill("SIGTERM");
        await Promise.race([once(current, "exit").catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 300))]);
        if (current.exitCode === null) current.kill("SIGKILL");
      }
      if (!this.stopping) this.spawnEncoder();
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.restartPromise;
    const current = this.child;
    this.child = undefined;
    if (current && current.exitCode === null) {
      current.kill("SIGTERM");
      await Promise.race([once(current, "exit").catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 500))]);
      if (current.exitCode === null) current.kill("SIGKILL");
    }
  }

  private spawnEncoder(): void {
    const output = scaledVideoSize(this.geometry.width, this.geometry.height);
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-f", "x11grab", "-framerate", String(DEFAULT_FPS), "-draw_mouse", "0",
      "-window_id", String(this.geometry.windowId), "-i", this.display,
      "-an", "-vf", `scale=${output.width}:${output.height}`,
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
    const parser = new AnnexBAccessUnitParser((units, keyframe) => {
      if (!this.frameDiagnosticSent) {
        this.frameDiagnosticSent = true;
        process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=frame_ready\n");
      }
      const timestamp = Math.max(0, Math.floor((performance.now() - this.startedAt) * 90)) >>> 0;
      this.writer.submit(frameRecord(avccFromNalUnits(units), timestamp, keyframe, output.width, output.height));
    });
    child.stdout.on("data", (chunk: Buffer) => parser.push(chunk));
    child.stdout.once("end", () => parser.end());
    let ffmpegDiagnostic = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (ffmpegDiagnostic.length < 4_096) ffmpegDiagnostic += chunk.toString("utf8").slice(0, 4_096 - ffmpegDiagnostic.length);
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

function absoluteTool(name: string, envName: string): string {
  const configured = process.env[envName]?.trim();
  if (configured) {
    if (!configured.startsWith("/")) throw new Error(`${envName} must be an absolute path`);
    return configured;
  }
  return `/usr/bin/${name}`;
}

export async function linuxWebRtcHostMain(): Promise<void> {
  if (process.platform !== "linux") throw new Error("Linux WebRTC host is available only on Linux");
  const targetPid = Number(process.env.TAKEOVER_WEBRTC_TARGET_PID);
  const expiresAt = Number(process.env.TAKEOVER_WEBRTC_EXPIRES_AT_UNIX_MS);
  const display = process.env.TAKEOVER_WEBRTC_DISPLAY_NAME?.trim();
  if (!Number.isSafeInteger(targetPid) || targetPid <= 0) throw new Error("TAKEOVER_WEBRTC_TARGET_PID is required");
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new Error("TAKEOVER_WEBRTC_EXPIRES_AT_UNIX_MS is invalid or expired");
  if (!display || !/^:\d+(?:\.\d+)?$/.test(display)) throw new Error("TAKEOVER_WEBRTC_DISPLAY_NAME must be a local X11 display such as :99");

  const xdotool = absoluteTool("xdotool", "TAKEOVER_LINUX_XDOTOOL");
  const xclip = absoluteTool("xclip", "TAKEOVER_LINUX_XCLIP");
  const ffmpeg = absoluteTool("ffmpeg", "TAKEOVER_LINUX_FFMPEG");
  const geometry = await resolveExactWindow(targetPid, display, xdotool);
  process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=window_ready\n");
  const input = new LinuxWindowInput(geometry, display, xdotool, xclip);
  let stopped = false;
  let stopHost!: () => Promise<void>;
  const capture = new LinuxCapture(geometry, display, ffmpeg, new LatestFrameWriter(), () => {
    process.exitCode = 1;
    void stopHost();
  });


  let pending = Buffer.alloc(0);
  let inputChain = Promise.resolve();
  stopHost = async () => {
    if (stopped) return;
    stopped = true;
    await capture.stop();
  };
  capture.start();
  const expiry = setTimeout(() => { void stopHost(); }, Math.max(0, expiresAt - Date.now()));

  process.stdin.on("data", (chunk: Buffer) => {
    if (stopped) return;
    pending = pending.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
    if (pending.byteLength > MAX_PENDING_INPUT_BYTES) {
      void stopHost();
      return;
    }
    for (;;) {
      const newline = pending.indexOf(0x0a);
      if (newline < 0) break;
      const line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (line.byteLength < 1 || line.byteLength > MAX_INPUT_LINE_BYTES) continue;
      let value: unknown;
      try { value = JSON.parse(line.toString("utf8")); } catch { continue; }
      const command = parseHostInput(value);
      if (!command) continue;
      if (command.kind === "stop") { void stopHost(); continue; }
      if (command.kind === "requestIDR") { capture.requestIDR(); continue; }
      inputChain = inputChain
        .then(() => input.apply(command))
        .catch(() => { process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=input_failure\n"); });
    }
  });
  process.stdin.once("end", () => { void stopHost(); });
  process.once("SIGTERM", () => { void stopHost(); });
  process.once("SIGINT", () => { void stopHost(); });

  while (!stopped) await new Promise((resolve) => setTimeout(resolve, 40));
  clearTimeout(expiry);
  await inputChain;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  linuxWebRtcHostMain().catch(() => { process.exitCode = 1; });
}
