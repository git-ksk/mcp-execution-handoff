import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";
import type { TakeoverHostTarget } from "../browser-takeover/broker.js";
import type {
  ExperimentalWebSocketWindowCaptureFailureDisposition,
  ExperimentalWebSocketWindowSurface
} from "./websocket-window-handoff.js";
import type { WebSocketTakeoverEditableRegion, WebSocketTakeoverFrame } from "./websocket-takeover.js";
import type { ManagedOperatorDiagnosticEventKind } from "./managed-operator-diagnostics.js";

const MAX_HOST_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_DIAGNOSTIC_BUFFER_BYTES = 8 * 1024;
const FRAME_WAIT_TIMEOUT_MS = 4_000;
const CAPTURE_RECOVERY_ATTEMPTS = 2;
const CAPTURE_RECOVERY_DELAY_MS = 120;
const INPUT_ACK_TIMEOUT_MS = 4_000;
const HELPER_STOP_TIMEOUT_MS = 1_000;
const QUERY_TIMEOUT_MS = 2_000;
const AUTHORITY_HELPER_READY_TIMEOUT_MS = 2_000;

export type LinuxWebSocketSurfaceFailure =
  | "none"
  | "frame_timeout"
  | "helper_closed"
  | "helper_error"
  | "frame_protocol"
  | "diagnostics_bounds"
  | "input_failure"
  | "input_timeout"
  | "input_revalidation_failure"
  | "revalidation_failure"
  | "capture_x11"
  | "capture_encoder"
  | "capture_option"
  | "capture_other";


export type LinuxWebSocketInputStage =
  | "none"
  | "focus_ready"
  | "pointer_move_ready"
  | "pointer_authority_ready"
  | "pointer_down_sent"
  | "pointer_post_authority_ready"
  | "tap_sent"
  | "key_down_sent"
  | "key_authority_ready"
  | "key_up_sent"
  | "applied";

export type LinuxWebSocketInputBoundaryStage =
  | "none"
  | "requested"
  | "helper_ready"
  | "revalidation_ready"
  | "command_sent"
  | "acknowledged";

export type LinuxWebSocketInputFailureDetail =
  | "none"
  | "xtest_unavailable"
  | "xtest_busy"
  | "xtest_invalid"
  | "xtest_ack_timeout"
  | "xtest_write_failure"
  | "xtest_output_bounds"
  | "xtest_protocol_mismatch"
  | "xtest_unexpected_response"
  | "xtest_state_rejected"
  | "xtest_xtest_rejected"
  | "xtest_protocol_rejected"
  | "xtest_process_error"
  | "xtest_process_closed";

export type LinuxWebSocketHelperStopReason =
  | "none"
  | "capture_failure"
  | "input_failure"
  | "stdin_end"
  | "signal_term"
  | "signal_int"
  | "expiry"
  | "input_buffer_bounds"
  | "explicit_stop";

export type LinuxWebSocketHelperCrashReason =
  | "none"
  | "uncaught_exception"
  | "main_rejection";

export type LinuxWebSocketHelperExitKind =
  | "none"
  | "clean"
  | "nonzero"
  | "signal";

export type LinuxWebSocketHelperCrashClass =
  | "none"
  | "pipe_epipe"
  | "stream_write_after_end"
  | "stream_destroyed"
  | "jpeg_parser"
  | "frame_writer"
  | "input_callback"
  | "xtest_callback"
  | "accessibility_callback"
  | "capture_callback"
  | "stream_internal"
  | "event_dispatch"
  | "child_process_internal"
  | "special_key"
  | "exact_window_revalidate"
  | "active_target_check"
  | "focus_target_check"
  | "scroll_input"
  | "text_input"
  | "host_input_apply"
  | "host_input_chain"
  | "host_module"
  | "unknown";

export type LinuxWebSocketHelperCrashOrigin =
  | "none"
  | "uncaught_exception"
  | "unhandled_rejection"
  | "unknown";

export type LinuxWebSocketHelperCrashErrorKind =
  | "none"
  | "error"
  | "type_error"
  | "range_error"
  | "other";

export type LinuxWebSocketHelperCrashMessageClass =
  | "none"
  | "focus_not_owned"
  | "window_not_active"
  | "target_process_unavailable"
  | "window_not_visible"
  | "window_owner_changed"
  | "window_geometry_unavailable"
  | "special_key_geometry_changed"
  | "xtest_helper_unavailable"
  | "xtest_helper_busy"
  | "xtest_helper_ack_timeout"
  | "xtest_helper_rejected"
  | "atspi_unavailable"
  | "atspi_busy"
  | "atspi_timeout"
  | "atspi_readiness_timeout"
  | "atspi_response_failed"
  | "atspi_response_invalid"
  | "atspi_response_large"
  | "atspi_regions_many"
  | "atspi_region_invalid"
  | "atspi_region_bounds"
  | "atspi_write_failure"
  | "atspi_output_bounds"
  | "atspi_protocol_mismatch"
  | "atspi_unexpected_response"
  | "atspi_process_failed"
  | "atspi_process_closed"
  | "atspi_failed"
  | "helper_command_timeout"
  | "helper_command_failed"
  | "other";

export interface ExperimentalLinuxWebSocketWindowSurfaceConfig {
  hostScript: string;
  displayName: string;
  xdotoolExecutable?: string;
  authorityHelperExecutable?: string;
  helperTtlMs?: number;
  /** Content-free bounded event hook owned by managed Handoff diagnostics. */
  onDiagnosticEvent?: (kind: ManagedOperatorDiagnosticEventKind) => void;
}

export interface LinuxWebSocketJpegFrame {
  data: Buffer;
  width: number;
  height: number;
}

/** Parses private JPEG records while accepting the helper's bounded editable-focus control record. */
export class LinuxWebSocketHostRecordParser {
  #pending = Buffer.alloc(0);

  constructor(
    private readonly onFrame: (frame: LinuxWebSocketJpegFrame) => void,
    private readonly onEditableFocus: (editable: boolean) => void = () => undefined
  ) {}

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
        this.onEditableFocus(payload[0] === 1);
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
  authority: LinuxWindowAuthorityHelper;
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
  readonly #authorityHelperExecutable: string;
  readonly #helperTtlMs: number;
  #active: ActiveLinuxSurface | undefined;
  #transition: Promise<void> | undefined;
  #lastFailure: LinuxWebSocketSurfaceFailure = "none";
  #failure: LinuxWebSocketSurfaceFailure = "none";
  #framesObserved = 0;
  #editableRegions: WebSocketTakeoverEditableRegion[] = [];
  #editableRegionPresence: "unknown" | "available" | "empty" = "unknown";
  #lastInputStage: LinuxWebSocketInputStage = "none";
  #lastInputBoundaryStage: LinuxWebSocketInputBoundaryStage = "none";
  #failureInputStage: LinuxWebSocketInputStage = "none";
  #failureInputBoundaryStage: LinuxWebSocketInputBoundaryStage = "none";
  #lastInputFailureDetail: LinuxWebSocketInputFailureDetail = "none";
  #failureInputFailureDetail: LinuxWebSocketInputFailureDetail = "none";
  #lastHelperStopReason: LinuxWebSocketHelperStopReason = "none";
  #failureHelperStopReason: LinuxWebSocketHelperStopReason = "none";
  #lastHelperCrashReason: LinuxWebSocketHelperCrashReason = "none";
  #failureHelperCrashReason: LinuxWebSocketHelperCrashReason = "none";
  #lastHelperExitKind: LinuxWebSocketHelperExitKind = "none";
  #failureHelperExitKind: LinuxWebSocketHelperExitKind = "none";
  #lastHelperCrashClass: LinuxWebSocketHelperCrashClass = "none";
  #failureHelperCrashClass: LinuxWebSocketHelperCrashClass = "none";
  #lastHelperCrashOrigin: LinuxWebSocketHelperCrashOrigin = "none";
  #failureHelperCrashOrigin: LinuxWebSocketHelperCrashOrigin = "none";
  #lastHelperCrashErrorKind: LinuxWebSocketHelperCrashErrorKind = "none";
  #failureHelperCrashErrorKind: LinuxWebSocketHelperCrashErrorKind = "none";
  #lastHelperCrashMessageClass: LinuxWebSocketHelperCrashMessageClass = "none";
  #failureHelperCrashMessageClass: LinuxWebSocketHelperCrashMessageClass = "none";
  #inputAttempts = 0;
  #authorityBoundary: "valid" | "lost" = "valid";
  readonly #onDiagnosticEvent: ((kind: ManagedOperatorDiagnosticEventKind) => void) | undefined;

  constructor(config: ExperimentalLinuxWebSocketWindowSurfaceConfig) {
    if (!config.hostScript.trim() || !isAbsolute(config.hostScript)) {
      throw new Error("Linux WSS host script must be an absolute path");
    }
    if (!/^:\d+(?:\.\d+)?$/.test(config.displayName)) {
      throw new Error("Linux WSS display name must be a local X11 display such as :99");
    }
    const xdotoolExecutable = config.xdotoolExecutable ?? "/usr/bin/xdotool";
    if (!isAbsolute(xdotoolExecutable)) throw new Error("Linux WSS xdotool executable must be absolute");
    const authorityHelperExecutable = config.authorityHelperExecutable ?? packagedLinuxWindowAuthorityHelper(import.meta.url);
    if (!isAbsolute(authorityHelperExecutable)) throw new Error("Linux WSS authority helper executable must be absolute");
    const helperTtlMs = config.helperTtlMs ?? 15 * 60_000;
    if (!Number.isSafeInteger(helperTtlMs) || helperTtlMs < 30_000 || helperTtlMs > 60 * 60_000) {
      throw new Error("Linux WSS helper ttl is invalid");
    }
    this.#hostScript = config.hostScript;
    this.#displayName = config.displayName;
    this.#xdotoolExecutable = xdotoolExecutable;
    this.#authorityHelperExecutable = authorityHelperExecutable;
    this.#helperTtlMs = helperTtlMs;
    this.#onDiagnosticEvent = config.onDiagnosticEvent;
  }

  diagnosticsSnapshot(): {
    lastFailure: LinuxWebSocketSurfaceFailure;
    framesObserved: number;
    lastInputStage: LinuxWebSocketInputStage;
    lastInputBoundaryStage: LinuxWebSocketInputBoundaryStage;
    inputAttempts: number;
    failure: LinuxWebSocketSurfaceFailure;
    failureInputStage: LinuxWebSocketInputStage;
    failureInputBoundaryStage: LinuxWebSocketInputBoundaryStage;
    lastInputFailureDetail: LinuxWebSocketInputFailureDetail;
    failureInputFailureDetail: LinuxWebSocketInputFailureDetail;
    lastHelperStopReason: LinuxWebSocketHelperStopReason;
    failureHelperStopReason: LinuxWebSocketHelperStopReason;
    lastHelperCrashReason: LinuxWebSocketHelperCrashReason;
    failureHelperCrashReason: LinuxWebSocketHelperCrashReason;
    lastHelperExitKind: LinuxWebSocketHelperExitKind;
    failureHelperExitKind: LinuxWebSocketHelperExitKind;
    lastHelperCrashClass: LinuxWebSocketHelperCrashClass;
    failureHelperCrashClass: LinuxWebSocketHelperCrashClass;
    lastHelperCrashOrigin: LinuxWebSocketHelperCrashOrigin;
    failureHelperCrashOrigin: LinuxWebSocketHelperCrashOrigin;
    lastHelperCrashErrorKind: LinuxWebSocketHelperCrashErrorKind;
    failureHelperCrashErrorKind: LinuxWebSocketHelperCrashErrorKind;
    lastHelperCrashMessageClass: LinuxWebSocketHelperCrashMessageClass;
    failureHelperCrashMessageClass: LinuxWebSocketHelperCrashMessageClass;
    authorityBoundary: "valid" | "lost";
  } {
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
      failureHelperCrashMessageClass: this.#failureHelperCrashMessageClass,
      authorityBoundary: this.#authorityBoundary
    };
  }

  captureFailureDisposition(error: unknown): ExperimentalWebSocketWindowCaptureFailureDisposition {
    return isExactWindowBoundaryError(error) ? "authority_lost" : "recoverable";
  }

  editableRegionsSnapshot(): WebSocketTakeoverEditableRegion[] {
    return this.#editableRegions.map((region) => [...region] as WebSocketTakeoverEditableRegion);
  }

  async captureExactWindow(target: Readonly<TakeoverHostTarget>): Promise<WebSocketTakeoverFrame> {
    let lastError: unknown;
    for (let attempt = 0; attempt < CAPTURE_RECOVERY_ATTEMPTS; attempt += 1) {
      let active: ActiveLinuxSurface;
      try {
        active = await this.#ensure(target);
      } catch (error) {
        if (isExactWindowBoundaryError(error)) { this.#noteAuthorityLoss(); throw error; }
        if (attempt + 1 >= CAPTURE_RECOVERY_ATTEMPTS) throw error;
        this.#onDiagnosticEvent?.("capture_recovery_attempt");
        lastError = error;
        await delay(CAPTURE_RECOVERY_DELAY_MS);
        continue;
      }
      const before = active.sequence;
      try {
        await this.#revalidate(target, active);
      } catch (error) {
        this.#recordFailure("revalidation_failure");
        if (isExactWindowBoundaryError(error)) this.#noteAuthorityLoss();
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
      } catch (error) {
        lastError = error;
        if (isExactWindowBoundaryError(error)) { this.#noteAuthorityLoss(); throw error; }
        if (error instanceof Error && error.message.includes("frame timed out")) {
          this.#recordFailure("frame_timeout");
        }
        if (attempt + 1 >= CAPTURE_RECOVERY_ATTEMPTS) throw error;
        this.#onDiagnosticEvent?.("capture_recovery_attempt");
        // Keep the authority boundary exact: fence only the failed helper process, then recreate it
        // for the same PID/window after the next mandatory ownership revalidation.
        failActive(active, "Linux WSS exact-window helper capture stalled");
        await delay(CAPTURE_RECOVERY_DELAY_MS);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Linux WSS exact-window capture failed");
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
    this.#inputAttempts += 1;
    this.#lastInputStage = "none";
    this.#lastInputFailureDetail = "none";
    this.#lastInputBoundaryStage = "requested";
    const active = await this.#ensure(target);
    this.#lastInputBoundaryStage = "helper_ready";
    active.inputChain = active.inputChain.then(async () => {
      if (active.failed || this.#active !== active) throw new Error("Linux WSS exact-window helper is unavailable");
      try {
        await this.#revalidate(target, active);
        this.#lastInputBoundaryStage = "revalidation_ready";
      } catch (error) {
        this.#recordFailure("input_revalidation_failure");
        if (isExactWindowBoundaryError(error)) this.#noteAuthorityLoss();
        throw error;
      }
      if (active.pendingInputAck) throw new Error("Linux WSS exact-window helper input is busy");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (active.pendingInputAck?.timer !== timer) return;
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
    if (previous) this.#onDiagnosticEvent?.("helper_restart");
    this.#active = undefined;
    if (previous) await stopActive(previous);
    const authority = await LinuxWindowAuthorityHelper.start(
      this.#authorityHelperExecutable, target, this.#displayName
    );
    try { await this.#revalidate(target, authority); } catch (error) { await authority.close(); throw error; }
    const child = spawn(process.execPath, [this.#hostScript], {
      env: {
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        TAKEOVER_WEBRTC_TARGET_PID: String(target.processId),
        TAKEOVER_WEBRTC_TARGET_WINDOW_ID: String(target.windowId),
        TAKEOVER_WEBRTC_EXPIRES_AT_UNIX_MS: String(Date.now() + this.#helperTtlMs),
        TAKEOVER_WEBRTC_DISPLAY_NAME: this.#displayName,
        TAKEOVER_WEBRTC_FRAME_FORMAT: "jpeg",
        TAKEOVER_LINUX_XDOTOOL: this.#xdotoolExecutable
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
      inputChain: Promise.resolve(),
      authority
    };
    this.#editableRegionPresence = "unknown";
    const parser = new LinuxWebSocketHostRecordParser(
      (frame) => {
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
      },
      (editable) => this.#onDiagnosticEvent?.(editable ? "host_focus_editable" : "host_focus_not_editable")
    );
    child.stdout.on("data", (chunk: Buffer) => {
      try { parser.push(chunk); } catch {
        this.#recordFailure("frame_protocol");
        failActive(state, "Linux WSS exact-window helper frame protocol failed");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => consumeDiagnostics(
      state,
      chunk,
      (regions) => {
        this.#editableRegions = regions;
        const presence = regions.length > 0 ? "available" : "empty";
        if (presence !== this.#editableRegionPresence) {
          this.#editableRegionPresence = presence;
          this.#onDiagnosticEvent?.(
            presence === "available" ? "host_editable_regions_available" : "host_editable_regions_empty"
          );
        }
      },
      (stage) => {
      const category = captureFailureCategory(stage);
      if (category) this.#recordFailure(category);
      else if (stage === "input_failure") this.#recordFailure("input_failure");
      const inputStage = boundedInputStage(stage);
      if (inputStage) this.#lastInputStage = inputStage;
      const inputFailureDetail = boundedInputFailureDetail(stage);
      if (inputFailureDetail) this.#lastInputFailureDetail = inputFailureDetail;
      const helperStopReason = boundedHelperStopReason(stage);
      if (helperStopReason) this.#lastHelperStopReason = helperStopReason;
      const helperCrashReason = boundedHelperCrashReason(stage);
      if (helperCrashReason) this.#lastHelperCrashReason = helperCrashReason;
      const helperCrashClass = boundedHelperCrashClass(stage);
      if (helperCrashClass) this.#lastHelperCrashClass = helperCrashClass;
      const helperCrashOrigin = boundedHelperCrashOrigin(stage);
      if (helperCrashOrigin) this.#lastHelperCrashOrigin = helperCrashOrigin;
      const helperCrashErrorKind = boundedHelperCrashErrorKind(stage);
      if (helperCrashErrorKind) this.#lastHelperCrashErrorKind = helperCrashErrorKind;
      const helperCrashMessageClass = boundedHelperCrashMessageClass(stage);
      if (helperCrashMessageClass) this.#lastHelperCrashMessageClass = helperCrashMessageClass;
      }
    ));
    child.once("error", () => {
      if (this.#lastFailure === "none") this.#recordFailure("helper_error");
      failActive(state, "Linux WSS exact-window helper failed");
    });
    child.once("close", (code, signal) => {
      this.#lastHelperExitKind = signal !== null ? "signal" : code === 0 ? "clean" : "nonzero";
      if (this.#lastFailure === "none") this.#recordFailure("helper_closed");
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

  #recordFailure(failure: LinuxWebSocketSurfaceFailure): void {
    this.#lastFailure = failure;
    if (failure === "input_failure" || failure === "input_timeout" || failure === "input_revalidation_failure") {
      this.#onDiagnosticEvent?.("input_dispatch_failure");
    }
    if (this.#failure !== "none") return;
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

  #noteAuthorityLoss(): void {
    if (this.#authorityBoundary === "lost") return;
    this.#authorityBoundary = "lost";
    this.#onDiagnosticEvent?.("authority_boundary_lost");
  }

  async #revalidate(
    target: Readonly<TakeoverHostTarget>,
    activeOrAuthority: ActiveLinuxSurface | LinuxWindowAuthorityHelper
  ): Promise<void> {
    validateExactTarget(target);
    try { process.kill(target.processId, 0); } catch { throw new Error("Linux WSS target process is unavailable"); }
    const authority = activeOrAuthority instanceof LinuxWindowAuthorityHelper
      ? activeOrAuthority
      : activeOrAuthority.authority;
    const result = await authority.query();
    if (result === "visible_owner_geometry_valid") { this.#authorityBoundary = "valid"; return; }
    if (result === "window_not_visible") throw new Error("Linux WSS target window is no longer visible");
    if (result === "owner_changed") throw new Error("Linux WSS target window ownership changed");
    throw new Error("Linux WSS target window geometry is unavailable");
  }
}


type LinuxWindowAuthorityResult =
  | "visible_owner_geometry_valid"
  | "window_not_visible"
  | "owner_changed"
  | "geometry_unavailable";

class LinuxWindowAuthorityHelper {
  readonly #child: ChildProcessByStdio<Writable, Readable, null>;
  #output = "";
  #ready = false;
  #pending: { resolve: (value: LinuxWindowAuthorityResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | undefined;
  #queryChain: Promise<void> = Promise.resolve();
  #closing = false;

  private constructor(executable: string, target: Readonly<TakeoverHostTarget>, displayName: string) {
    this.#child = spawn(executable, ["--pid", String(target.processId), "--window", String(target.windowId)], {
      env: { DISPLAY: displayName, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
      stdio: ["pipe", "pipe", "ignore"]
    });
    this.#child.stdout.on("data", (chunk: Buffer) => this.#consume(chunk));
    this.#child.once("error", () => this.#fail(new Error("Linux WSS authority helper failed")));
    this.#child.once("close", () => this.#fail(new Error("Linux WSS authority helper closed")));
  }

  static async start(executable: string, target: Readonly<TakeoverHostTarget>, displayName: string): Promise<LinuxWindowAuthorityHelper> {
    const helper = new LinuxWindowAuthorityHelper(executable, target, displayName);
    const deadline = Date.now() + AUTHORITY_HELPER_READY_TIMEOUT_MS;
    while (!helper.#ready && helper.#child.exitCode === null && helper.#child.signalCode === null && Date.now() < deadline) {
      await delay(10);
    }
    if (!helper.#ready) { await helper.close(); throw new Error("Linux WSS authority helper readiness failed"); }
    return helper;
  }

  query(): Promise<LinuxWindowAuthorityResult> {
    let resolveResult!: (value: LinuxWindowAuthorityResult) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<LinuxWindowAuthorityResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.#queryChain = this.#queryChain
      .catch(() => undefined)
      .then(async () => {
        try { resolveResult(await this.#queryOnce()); }
        catch (error) { rejectResult(error instanceof Error ? error : new Error("Linux WSS authority helper query failed")); }
      });
    return result;
  }

  #queryOnce(): Promise<LinuxWindowAuthorityResult> {
    if (!this.#ready || this.#closing || this.#child.exitCode !== null || this.#child.signalCode !== null) {
      return Promise.reject(new Error("Linux WSS authority helper is unavailable"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending?.timer !== timer) return;
        this.#pending = undefined;
        reject(new Error("Linux WSS authority helper query timed out"));
      }, QUERY_TIMEOUT_MS);
      timer.unref();
      this.#pending = { resolve, reject, timer };
      this.#child.stdin.write("QUERY\n", (error) => { if (error) this.#fail(error); });
    });
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error("Linux WSS authority helper closed")); }
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    try { this.#child.stdin.end("CLOSE\n"); } catch {}
    const closed = await Promise.race([
      once(this.#child, "close").then(() => true, () => true),
      delay(250).then(() => false)
    ]);
    if (!closed && this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill("SIGTERM");
  }

  #consume(chunk: Buffer): void {
    this.#output += chunk.toString("utf8");
    if (this.#output.length > 1024) { this.#fail(new Error("Linux WSS authority helper output exceeded bounds")); return; }
    for (;;) {
      const newline = this.#output.indexOf("\n");
      if (newline < 0) return;
      const line = this.#output.slice(0, newline).trim();
      this.#output = this.#output.slice(newline + 1);
      if (!this.#ready) {
        if (line === "READY 1") { this.#ready = true; continue; }
        this.#fail(new Error("Linux WSS authority helper protocol mismatch")); return;
      }
      const pending = this.#pending;
      if (!pending) continue;
      this.#pending = undefined;
      clearTimeout(pending.timer);
      if (line === "OK") pending.resolve("visible_owner_geometry_valid");
      else if (line === "ERR VISIBILITY") pending.resolve("window_not_visible");
      else if (line === "ERR OWNER") pending.resolve("owner_changed");
      else if (line === "ERR GEOMETRY") pending.resolve("geometry_unavailable");
      else pending.reject(new Error("Linux WSS authority helper protocol mismatch"));
    }
  }

  #fail(error: Error): void {
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
  }
}

function packagedLinuxWindowAuthorityHelper(moduleUrl: string): string {
  return fileURLToPath(new URL("../native/mcp-handoff-linux-window-authority-helper", moduleUrl));
}

function isExactWindowBoundaryError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === "Linux WSS target process is unavailable"
    || error.message === "Linux WSS target window is no longer visible"
    || error.message === "Linux WSS target window ownership changed"
    || error.message === "Linux WSS target window geometry is unavailable";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  onEditableRegions: (regions: WebSocketTakeoverEditableRegion[]) => void,
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
    const editable = /^MCP_HANDOFF_CONTROL editable_regions=(.*)$/.exec(line);
    if (editable) {
      try { onEditableRegions(parseEditableRegions(editable[1] ?? "")); }
      catch { onStage("diagnostics_bounds"); failActive(active, "Linux WSS editable-region metadata exceeded bounds"); return; }
      continue;
    }
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

function parseEditableRegions(payload: string): WebSocketTakeoverEditableRegion[] {
  if (payload.length > 1_024) throw new Error("Linux WSS editable-region metadata is too large");
  if (!payload) return [];
  const items = payload.split(";");
  if (items.length > 32) throw new Error("Linux WSS editable-region metadata has too many regions");
  return items.map((item) => {
    const match = /^(\d{1,5}),(\d{1,5}),(\d{1,5}),(\d{1,5})$/.exec(item);
    if (!match) throw new Error("Linux WSS editable-region metadata is invalid");
    const values = match.slice(1).map(Number) as WebSocketTakeoverEditableRegion;
    const [x, y, width, height] = values;
    if (!values.every(Number.isSafeInteger) || x < 0 || y < 0 || width < 1 || height < 1 || x + width > 10_000 || y + height > 10_000) {
      throw new Error("Linux WSS editable-region metadata is out of bounds");
    }
    return values;
  });
}

function boundedInputStage(stage: string): LinuxWebSocketInputStage | undefined {
  if (stage === "input_focus_ready") return "focus_ready";
  if (stage === "input_pointer_move_ready") return "pointer_move_ready";
  if (stage === "input_pointer_authority_ready") return "pointer_authority_ready";
  if (stage === "input_pointer_down_sent") return "pointer_down_sent";
  if (stage === "input_pointer_post_authority_ready") return "pointer_post_authority_ready";
  if (stage === "input_tap_sent") return "tap_sent";
  if (stage === "input_key_down_sent") return "key_down_sent";
  if (stage === "input_key_authority_ready") return "key_authority_ready";
  if (stage === "input_key_up_sent") return "key_up_sent";
  if (stage === "input_applied") return "applied";
  return undefined;
}

function boundedInputFailureDetail(stage: string): LinuxWebSocketInputFailureDetail | undefined {
  const match = /^input_xtest_(unavailable|busy|invalid|ack_timeout|write_failure|output_bounds|protocol_mismatch|unexpected_response|state_rejected|xtest_rejected|protocol_rejected|process_error|process_closed)$/.exec(stage);
  return match ? (`xtest_${match[1]}` as LinuxWebSocketInputFailureDetail) : undefined;
}

function boundedHelperStopReason(stage: string): LinuxWebSocketHelperStopReason | undefined {
  const match = /^host_stop_(capture_failure|input_failure|stdin_end|signal_term|signal_int|expiry|input_buffer_bounds|explicit_stop)$/.exec(stage);
  return match ? (match[1] as LinuxWebSocketHelperStopReason) : undefined;
}

function boundedHelperCrashReason(stage: string): LinuxWebSocketHelperCrashReason | undefined {
  if (stage === "host_crash_uncaught_exception") return "uncaught_exception";
  if (stage === "host_crash_main_rejection") return "main_rejection";
  return undefined;
}

function boundedHelperCrashClass(stage: string): LinuxWebSocketHelperCrashClass | undefined {
  const match = /^host_crash_class_(pipe_epipe|stream_write_after_end|stream_destroyed|jpeg_parser|frame_writer|input_callback|xtest_callback|accessibility_callback|capture_callback|stream_internal|event_dispatch|child_process_internal|special_key|exact_window_revalidate|active_target_check|focus_target_check|scroll_input|text_input|host_input_apply|host_input_chain|host_module|unknown)$/.exec(stage);
  return match ? (match[1] as LinuxWebSocketHelperCrashClass) : undefined;
}

function boundedHelperCrashOrigin(stage: string): LinuxWebSocketHelperCrashOrigin | undefined {
  const match = /^host_crash_origin_(uncaught_exception|unhandled_rejection|unknown)$/.exec(stage);
  return match ? (match[1] as LinuxWebSocketHelperCrashOrigin) : undefined;
}

function boundedHelperCrashErrorKind(stage: string): LinuxWebSocketHelperCrashErrorKind | undefined {
  const match = /^host_crash_error_(error|type_error|range_error|other)$/.exec(stage);
  return match ? (match[1] as LinuxWebSocketHelperCrashErrorKind) : undefined;
}


function boundedHelperCrashMessageClass(stage: string): LinuxWebSocketHelperCrashMessageClass | undefined {
  const match = /^host_crash_message_(focus_not_owned|window_not_active|target_process_unavailable|window_not_visible|window_owner_changed|window_geometry_unavailable|special_key_geometry_changed|xtest_helper_unavailable|xtest_helper_busy|xtest_helper_ack_timeout|xtest_helper_rejected|atspi_unavailable|atspi_busy|atspi_timeout|atspi_readiness_timeout|atspi_response_failed|atspi_response_invalid|atspi_response_large|atspi_regions_many|atspi_region_invalid|atspi_region_bounds|atspi_write_failure|atspi_output_bounds|atspi_protocol_mismatch|atspi_unexpected_response|atspi_process_failed|atspi_process_closed|atspi_failed|helper_command_timeout|helper_command_failed|other)$/.exec(stage);
  return match ? (match[1] as LinuxWebSocketHelperCrashMessageClass) : undefined;
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
  try {
    if (active.child.exitCode === null && active.child.signalCode === null) {
      active.child.stdin.on("error", () => undefined);
      if (!active.child.stdin.destroyed && !active.child.stdin.writableEnded) {
        active.child.stdin.end('{"kind":"stop"}\n');
      }
      const ended = await Promise.race([
        once(active.child, "close").then(() => true, () => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), HELPER_STOP_TIMEOUT_MS))
      ]);
      if (!ended && active.child.exitCode === null && active.child.signalCode === null) {
        active.child.kill("SIGTERM");
        await Promise.race([
          once(active.child, "close").catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 250))
        ]);
        if (active.child.exitCode === null && active.child.signalCode === null) active.child.kill("SIGKILL");
      }
    }
  } finally {
    await active.authority.close();
  }
}
