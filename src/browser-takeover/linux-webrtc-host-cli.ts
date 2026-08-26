#!/usr/bin/env node
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { realpathSync } from "node:fs";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  normalizedPointInWindow,
  scaledEvenWindowSize,
  selectExactBoundedWindow
} from "../target-surface/os-window.js";

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
  kind: "tap" | "pointer_button" | "scroll" | "text" | "key";
  button?: "primary";
  state?: "down" | "up";
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
  return scaledEvenWindowSize(width, height, DEFAULT_MAX_WIDTH, DEFAULT_MAX_HEIGHT);
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

export function parseOptionalTargetWindowId(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new Error("TAKEOVER_WEBRTC_TARGET_WINDOW_ID is invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("TAKEOVER_WEBRTC_TARGET_WINDOW_ID is invalid");
  return parsed;
}

async function resolveExactWindow(
  targetPid: number,
  targetWindowId: number | undefined,
  display: string,
  xdotool: string
): Promise<LinuxWindowGeometry> {
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
        const geometry = parseWindowGeometry(
          await runCommand(xdotool, ["getwindowgeometry", "--shell", String(targetWindowId)], display).catch(() => ""),
          targetWindowId
        );
        if (geometry) return geometry;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }

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
    if (candidates.length === 1) {
      const selected = selectExactBoundedWindow(
        candidates.map((candidate) => ({
          id: candidate.windowId,
          x: candidate.x,
          y: candidate.y,
          width: candidate.width,
          height: candidate.height
        })),
        { minWidth: MIN_WINDOW_WIDTH, minHeight: MIN_WINDOW_HEIGHT }
      );
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
    if (candidates.length > 1) observedMultiple = true;
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

function parseHostInput(value: unknown): LinuxHostInput | { kind: "stop" } | { kind: "requestIDR" } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === "stop" || record.kind === "requestIDR") return { kind: record.kind };
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
  if (record.kind === "key" && (record.key === "Backspace" || record.key === "Enter")) return { kind: "key", key: record.key };
  return undefined;
}

class LinuxWindowInput {
  private primaryPressed = false;
  private primaryPoint: { x: number; y: number } | undefined;

  constructor(
    private geometry: LinuxWindowGeometry,
    private readonly targetPid: number,
    private readonly display: string,
    private readonly xdotool: string
  ) {}

  async apply(input: LinuxHostInput): Promise<void> {
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
      await runCommand(this.xdotool, ["windowactivate", "--sync", String(this.geometry.windowId)], this.display);
      // Pointer operations may establish browser focus. Text/key operations must preserve the
      // Chromium-internal focused editable element selected by the preceding Human tap. Re-focusing
      // the top-level X11 window here can steal that internal focus before paste/Enter.
      if (input.kind === "tap" || input.kind === "pointer_button" || input.kind === "scroll") {
        await runCommand(this.xdotool, ["windowfocus", "--sync", String(this.geometry.windowId)], this.display);
      }
    }
    await this.confirmActiveTarget();
    await this.confirmInputFocusOwnedByTarget();
    process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=input_focus_ready\n");
    if (input.kind === "tap" || input.kind === "pointer_button") {
      const point = normalizedPointInWindow(
        {
          id: this.geometry.windowId,
          x: this.geometry.x,
          y: this.geometry.y,
          width: this.geometry.width,
          height: this.geometry.height
        },
        input.x!,
        input.y!
      );
      const x = Math.round(point.x);
      const y = Math.round(point.y);
      if (input.kind === "tap") {
        await this.postPrimaryButton("down", x, y);
        await new Promise((resolve) => setTimeout(resolve, 20));
        await this.postPrimaryButton("up", x, y);
        process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=input_tap_sent\n");
        return;
      }
      await this.postPrimaryButton(input.state!, x, y);
      if (input.state === "up") process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=input_tap_sent\n");
      return;
    }
    if (input.kind === "scroll") {
      await this.scrollAxis(input.deltaY ?? 0, 4, 5);
      await this.scrollAxis(input.deltaX ?? 0, 6, 7);
      return;
    }
    if (input.kind === "key") {
      const key = input.key === "Backspace" ? "BackSpace" : "Return";
      await runCommand(this.xdotool, ["key", "--clearmodifiers", key], this.display);
      return;
    }
    await this.typeText(input.text!);
  }


  private async postPrimaryButton(state: "down" | "up", x: number, y: number): Promise<void> {
    if (state === "down") {
      if (this.primaryPressed) throw new Error("Linux WebRTC primary button is already pressed");
      // `mousemove --sync` only waits for any movement away from the prior location, not for the
      // requested destination. Force an X11 round trip with getmouselocation in the same xdotool
      // invocation, then verify the exact root coordinates before admitting Button1 down. This
      // keeps the public input path on XTEST and never targets a button event via XSendEvent.
      const relativeX = x - this.geometry.x;
      const relativeY = y - this.geometry.y;
      await runCommand(this.xdotool, [
        "mousemove", "--window", String(this.geometry.windowId),
        String(relativeX), String(relativeY),
        "getmouselocation"
      ], this.display);
      // The round trip above closes the motion race. Re-check exact active/focus authority after
      // motion and immediately before the stateful XTEST button mutation.
      await this.confirmActiveTarget();
      await this.confirmInputFocusOwnedByTarget();
      await runCommand(this.xdotool, ["mousedown", "1"], this.display);
      this.primaryPressed = true;
      this.primaryPoint = { x, y };
      return;
    }
    const pressed = this.primaryPoint;
    if (!this.primaryPressed || !pressed) throw new Error("Linux WebRTC primary button is not pressed");
    // `pointer_button` is an internal lifecycle for the public tap policy, not a drag API. Require
    // release at the admitted press point and avoid another pointer move while Button1 is held.
    if (Math.abs(pressed.x - x) > 1 || Math.abs(pressed.y - y) > 1) {
      throw new Error("Linux WebRTC primary release point changed");
    }
    await runCommand(this.xdotool, ["mouseup", "1"], this.display);
    this.primaryPressed = false;
    this.primaryPoint = undefined;
  }

  async releaseAll(): Promise<void> {
    if (!this.primaryPressed) return;
    const releasePoint = await this.cancellationPoint();
    // Cleanup is intentionally a move/release away from the admitted control. It is serialized
    // after accepted input, so a shutdown race cannot leave Button1 pressed or activate the
    // original control.
    await runCommand(this.xdotool, [
      "mousemove", String(releasePoint.x), String(releasePoint.y),
      "mouseup", "1"
    ], this.display).catch(() => undefined);
    this.primaryPressed = false;
    this.primaryPoint = undefined;
  }

  private async cancellationPoint(): Promise<{ x: number; y: number }> {
    const raw = await runCommand(this.xdotool, ["getdisplaygeometry"], this.display).catch(() => "");
    const match = /^(\d+)\s+(\d+)$/.exec(raw.trim());
    const width = match ? Number(match[1]) : 0;
    const height = match ? Number(match[2]) : 0;
    const pressed = this.primaryPoint ?? { x: this.geometry.x, y: this.geometry.y };
    if (Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 1 && height > 1) {
      const safeX = Math.min(Math.max(pressed.x, 1), width - 2);
      const safeY = Math.min(Math.max(pressed.y, 1), height - 2);
      const margin = 2;
      if (this.geometry.x - margin >= 0) return { x: this.geometry.x - margin, y: safeY };
      if (this.geometry.x + this.geometry.width + margin < width) {
        return { x: this.geometry.x + this.geometry.width + margin, y: safeY };
      }
      if (this.geometry.y - margin >= 0) return { x: safeX, y: this.geometry.y - margin };
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

  private async currentOwnedGeometry(): Promise<LinuxWindowGeometry> {
    try { process.kill(this.targetPid, 0); } catch { throw new Error("Linux WebRTC target process is unavailable"); }
    const visibleRaw = await runCommand(this.xdotool, ["search", "--onlyvisible", "--pid", String(this.targetPid)], this.display).catch(() => "");
    if (!parseWindowIds(visibleRaw).includes(this.geometry.windowId)) {
      throw new Error("Linux WebRTC target window is no longer visible");
    }
    const pidText = await runCommand(this.xdotool, ["getwindowpid", String(this.geometry.windowId)], this.display).catch(() => "");
    if (Number(pidText.trim()) !== this.targetPid) {
      throw new Error("Linux WebRTC target window ownership changed");
    }
    const geometry = parseWindowGeometry(
      await runCommand(this.xdotool, ["getwindowgeometry", "--shell", String(this.geometry.windowId)], this.display).catch(() => ""),
      this.geometry.windowId
    );
    if (!geometry) throw new Error("Linux WebRTC target window geometry is unavailable");
    return geometry;
  }

  private async confirmActiveTarget(): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const active = await runCommand(this.xdotool, ["getactivewindow"], this.display).catch(() => "");
      if (Number(active.trim()) === this.geometry.windowId) return;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Linux WebRTC target window did not become active");
  }

  private async confirmInputFocusOwnedByTarget(): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const focused = await runCommand(this.xdotool, ["getwindowfocus"], this.display).catch(() => "");
      const focusedWindowId = Number(focused.trim());
      if (Number.isSafeInteger(focusedWindowId) && focusedWindowId > 0) {
        if (focusedWindowId === this.geometry.windowId) return;
        const focusedPid = await runCommand(this.xdotool, ["getwindowpid", String(focusedWindowId)], this.display).catch(() => "");
        if (Number(focusedPid.trim()) === this.targetPid) return;
      }
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Linux WebRTC input focus is not owned by the target process");
  }

  private async scrollAxis(delta: number, negativeButton: number, positiveButton: number): Promise<void> {
    if (!delta) return;
    const repeats = Math.max(1, Math.min(12, Math.ceil(Math.abs(delta) / 80)));
    const button = delta < 0 ? negativeButton : positiveButton;
    await runCommand(this.xdotool, ["click", "--window", String(this.geometry.windowId), "--repeat", String(repeats), String(button)], this.display);
  }

  private async typeText(text: string): Promise<void> {
    const child = spawn(this.xdotool, ["type", "--clearmodifiers", "--delay", "5", "--file", "-"], {
      env: boundedEnvironment(this.display),
      stdio: ["pipe", "ignore", "ignore"]
    });
    child.once("error", () => undefined);
    child.stdin.on("error", () => undefined);
    child.stdin.end(Buffer.from(text, "utf8"));
    const [code] = await once(child, "close") as [number | null, NodeJS.Signals | null];
    if (code !== 0) throw new Error("Linux WebRTC host text injection failed");
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
  const targetWindowId = parseOptionalTargetWindowId(process.env.TAKEOVER_WEBRTC_TARGET_WINDOW_ID);
  const expiresAt = Number(process.env.TAKEOVER_WEBRTC_EXPIRES_AT_UNIX_MS);
  const display = process.env.TAKEOVER_WEBRTC_DISPLAY_NAME?.trim();
  if (!Number.isSafeInteger(targetPid) || targetPid <= 0) {
    process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=target_missing\n");
    throw new Error("TAKEOVER_WEBRTC_TARGET_PID is required");
  }
  try {
    process.kill(targetPid, 0);
    process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=target_alive\n");
  } catch {
    process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=target_missing\n");
    throw new Error("TAKEOVER_WEBRTC_TARGET_PID is unavailable");
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new Error("TAKEOVER_WEBRTC_EXPIRES_AT_UNIX_MS is invalid or expired");
  if (!display || !/^:\d+(?:\.\d+)?$/.test(display)) throw new Error("TAKEOVER_WEBRTC_DISPLAY_NAME must be a local X11 display such as :99");

  const xdotool = absoluteTool("xdotool", "TAKEOVER_LINUX_XDOTOOL");
  const ffmpeg = absoluteTool("ffmpeg", "TAKEOVER_LINUX_FFMPEG");
  let geometry: LinuxWindowGeometry;
  try {
    geometry = await resolveExactWindow(targetPid, targetWindowId, display, xdotool);
  } catch (error) {
    const multiple = error instanceof Error && /did not converge/.test(error.message);
    process.stderr.write(`MCP_HANDOFF_DIAGNOSTIC linux_stage=${multiple ? "window_failure_multiple" : "window_failure_none"}\n`);
    throw error;
  }
  process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=window_ready\n");
  const input = new LinuxWindowInput(geometry, targetPid, display, xdotool);
  let stopped = false;
  let stopHost!: () => Promise<void>;
  const capture = new LinuxCapture(geometry, display, ffmpeg, new LatestFrameWriter(), () => {
    process.exitCode = 1;
    void stopHost();
  });

  let pending = Buffer.alloc(0);
  let inputChain = Promise.resolve();
  let stopPromise: Promise<void> | undefined;
  stopHost = () => {
    if (stopPromise) return stopPromise;
    stopped = true;
    // Serialize lifecycle cleanup after every already-admitted Human mutation. If shutdown races
    // an in-flight primary-down command, releasing outside the chain can observe primaryPressed
    // before mousedown completes and leave the X11 button stuck after helper exit.
    inputChain = inputChain
      .then(() => input.releaseAll())
      .catch(() => undefined);
    stopPromise = inputChain.then(() => capture.stop());
    return stopPromise;
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
        .catch(() => {
          process.stderr.write("MCP_HANDOFF_DIAGNOSTIC linux_stage=input_failure\n");
          void stopHost();
        });
    }
  });
  process.stdin.once("end", () => { void stopHost(); });
  process.once("SIGTERM", () => { void stopHost(); });
  process.once("SIGINT", () => { void stopHost(); });

  while (!stopped) await new Promise((resolve) => setTimeout(resolve, 40));
  clearTimeout(expiry);
  await stopPromise;
}

export function isLinuxWebRtcHostCliEntryPoint(moduleUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
  } catch {
    return false;
  }
}

if (isLinuxWebRtcHostCliEntryPoint(import.meta.url, process.argv[1])) {
  linuxWebRtcHostMain().catch(() => { process.exitCode = 1; });
}
