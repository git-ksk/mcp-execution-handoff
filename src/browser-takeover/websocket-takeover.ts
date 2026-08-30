export type WebSocketTakeoverState = "open" | "closing" | "closed" | "revoked" | "failed";

export type WebSocketTakeoverInputStage =
  | "none"
  | "received"
  | "authority_begin_ready"
  | "dispatch_started"
  | "dispatch_completed"
  | "authority_end_ready"
  | "applied";

/**
 * Trusted binding created only after Handoff-owned WSS ingress authenticates the principal,
 * validates the request Origin, and claims one client generation. Never populate these fields
 * from peer-controlled WebSocket messages.
 */
export interface WebSocketTakeoverBinding {
  interventionId: string;
  epoch: number;
  principalBinding: string;
  clientBinding: string;
  clientGeneration: number;
}

export interface WebSocketTakeoverInputPolicy {
  tap: boolean;
  scroll: boolean;
  text: boolean;
  key: boolean;
}

export type WebSocketTakeoverHumanInput =
  | { kind: "tap"; x: number; y: number }
  | { kind: "scroll"; deltaY: number }
  | { kind: "text"; text: string }
  | { kind: "key"; key: string };

/** Content-free browser-side milestones used only for bounded physical-acceptance diagnostics. */
export type WebSocketTakeoverClientDiagnosticKind =
  | "client_editable_regions_available"
  | "client_editable_regions_empty"
  | "client_tap_editable_predicted"
  | "client_tap_editable_not_predicted"
  | "client_keyboard_focus_requested"
  | "client_keyboard_focus_active"
  | "client_keyboard_focus_inactive";

export type WebSocketTakeoverEditableRegion = [number, number, number, number];

export interface WebSocketTakeoverFrame {
  data: Uint8Array;
  width: number;
  height: number;
  mimeType: "image/jpeg" | "image/png";
}

export type WebSocketTakeoverServerMessage =
  | { kind: "ready" }
  | { kind: "closing" }
  | { kind: "closed" }
  | { kind: "editableRegions"; regions: WebSocketTakeoverEditableRegion[] }
  | { kind: "pong"; nonce?: string }
  | { kind: "error"; code: WebSocketTakeoverFailureCode };

export interface WebSocketTakeoverPeer {
  sendControl(message: WebSocketTakeoverServerMessage): void | Promise<void>;
  sendFrame(frame: WebSocketTakeoverFrame): void | Promise<void>;
  bufferedAmount(): number;
  close(code: number, reason: string): void | Promise<void>;
}

export interface WebSocketTakeoverLease {
  beginUse(binding: WebSocketTakeoverBinding): void | Promise<void>;
  endUse(binding: WebSocketTakeoverBinding): void | Promise<void>;
  complete(binding: WebSocketTakeoverBinding): void | Promise<void>;
  release(binding: WebSocketTakeoverBinding): void | Promise<void>;
}

export interface ExperimentalWebSocketTakeoverOptions {
  binding: WebSocketTakeoverBinding;
  inputPolicy: WebSocketTakeoverInputPolicy;
  peer: WebSocketTakeoverPeer;
  lease: WebSocketTakeoverLease;
  onInput(input: WebSocketTakeoverHumanInput): void | Promise<void>;
  /** Observe-only finite enum. It never carries coordinates, text, identity, or browser content. */
  onClientDiagnostic?(kind: WebSocketTakeoverClientDiagnosticKind): void;
  maxInboundBytes?: number;
  maxFrameBytes?: number;
  maxBufferedBytes?: number;
}

export type WebSocketTakeoverFailureCode =
  | "invalid_message"
  | "input_not_allowed"
  | "stale_generation"
  | "frame_too_large"
  | "transport_failure"
  | "authority_release_failed";

export class WebSocketTakeoverError extends Error {
  constructor(
    public readonly code: WebSocketTakeoverFailureCode,
    message: string
  ) {
    super(message);
    this.name = "WebSocketTakeoverError";
  }
}

const DEFAULT_MAX_INBOUND_BYTES = 8 * 1024;
const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 512 * 1024;
const ABSOLUTE_MAX_INBOUND_BYTES = 64 * 1024;
const ABSOLUTE_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const ABSOLUTE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_SCROLL_DELTA = 2_000;
const MAX_TEXT_BYTES = 4 * 1024;
const MAX_KEY_BYTES = 64;
const NORMAL_CLOSE = 1000;
const POLICY_CLOSE = 1008;
const INTERNAL_CLOSE = 1011;

function boundedInteger(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
}

function boundedNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && utf8Length(value) <= maxBytes;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function validateBinding(binding: WebSocketTakeoverBinding): void {
  if (
    !binding.interventionId ||
    !boundedInteger(binding.epoch, 0, Number.MAX_SAFE_INTEGER) ||
    !binding.principalBinding ||
    !binding.clientBinding ||
    !boundedInteger(binding.clientGeneration, 1, Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("websocket takeover requires one exact active session binding");
  }
}

function boundedLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return resolved;
}

function parseHumanMessage(
  raw: string,
  maxInboundBytes: number,
  inputPolicy: WebSocketTakeoverInputPolicy
): WebSocketTakeoverHumanInput
  | { kind: "diagnostic"; event: WebSocketTakeoverClientDiagnosticKind }
  | { kind: "done" }
  | { kind: "ping"; nonce?: string } {
  if (utf8Length(raw) > maxInboundBytes) {
    throw new WebSocketTakeoverError("invalid_message", "WebSocket takeover message is too large");
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new WebSocketTakeoverError(
      "invalid_message",
      "WebSocket takeover message is invalid JSON"
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WebSocketTakeoverError(
      "invalid_message",
      "WebSocket takeover message must be an object"
    );
  }

  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case "tap":
      if (!hasOnlyKeys(record, ["kind", "x", "y"])) {
        throw new WebSocketTakeoverError("invalid_message", "Tap message has extra fields");
      }
      if (!inputPolicy.tap) {
        throw new WebSocketTakeoverError("input_not_allowed", "Tap input is not allowed");
      }
      if (!boundedNumber(record.x, 0, 1) || !boundedNumber(record.y, 0, 1)) {
        throw new WebSocketTakeoverError("invalid_message", "Tap coordinates must be normalized");
      }
      return { kind: "tap", x: record.x, y: record.y };
    case "scroll":
      if (!hasOnlyKeys(record, ["kind", "deltaY"])) {
        throw new WebSocketTakeoverError("invalid_message", "Scroll message has extra fields");
      }
      if (!inputPolicy.scroll) {
        throw new WebSocketTakeoverError("input_not_allowed", "Scroll input is not allowed");
      }
      if (!boundedInteger(record.deltaY, -MAX_SCROLL_DELTA, MAX_SCROLL_DELTA)) {
        throw new WebSocketTakeoverError("invalid_message", "Scroll delta is out of bounds");
      }
      return { kind: "scroll", deltaY: record.deltaY };
    case "text":
      if (!hasOnlyKeys(record, ["kind", "text"])) {
        throw new WebSocketTakeoverError("invalid_message", "Text message has extra fields");
      }
      if (!inputPolicy.text) {
        throw new WebSocketTakeoverError("input_not_allowed", "Text input is not allowed");
      }
      if (!boundedString(record.text, MAX_TEXT_BYTES)) {
        throw new WebSocketTakeoverError("invalid_message", "Text input is out of bounds");
      }
      return { kind: "text", text: record.text };
    case "key":
      if (!hasOnlyKeys(record, ["kind", "key"])) {
        throw new WebSocketTakeoverError("invalid_message", "Key message has extra fields");
      }
      if (!inputPolicy.key) {
        throw new WebSocketTakeoverError("input_not_allowed", "Key input is not allowed");
      }
      if (!boundedString(record.key, MAX_KEY_BYTES) || record.key.length === 0) {
        throw new WebSocketTakeoverError("invalid_message", "Key input is out of bounds");
      }
      return { kind: "key", key: record.key };
    case "diagnostic": {
      if (!hasOnlyKeys(record, ["kind", "event"])) {
        throw new WebSocketTakeoverError("invalid_message", "Diagnostic message has extra fields");
      }
      const events = new Set<WebSocketTakeoverClientDiagnosticKind>([
        "client_editable_regions_available",
        "client_editable_regions_empty",
        "client_tap_editable_predicted",
        "client_tap_editable_not_predicted",
        "client_keyboard_focus_requested",
        "client_keyboard_focus_active",
        "client_keyboard_focus_inactive"
      ]);
      if (!events.has(record.event as WebSocketTakeoverClientDiagnosticKind)) {
        throw new WebSocketTakeoverError("invalid_message", "Diagnostic event is invalid");
      }
      return { kind: "diagnostic", event: record.event as WebSocketTakeoverClientDiagnosticKind };
    }
    case "done":
      if (!hasOnlyKeys(record, ["kind"])) {
        throw new WebSocketTakeoverError("invalid_message", "Done message has extra fields");
      }
      return { kind: "done" };
    case "ping":
      if (record.nonce === undefined) {
        if (!hasOnlyKeys(record, ["kind"])) {
          throw new WebSocketTakeoverError("invalid_message", "Ping message has extra fields");
        }
        return { kind: "ping" };
      }
      if (!hasOnlyKeys(record, ["kind", "nonce"]) || !boundedString(record.nonce, 64)) {
        throw new WebSocketTakeoverError("invalid_message", "Ping nonce is out of bounds");
      }
      return { kind: "ping", nonce: record.nonce };
    default:
      throw new WebSocketTakeoverError("invalid_message", "Unknown WebSocket takeover message");
  }
}

export class ExperimentalWebSocketTakeoverChannel {
  private readonly binding: WebSocketTakeoverBinding;
  private readonly inputPolicy: WebSocketTakeoverInputPolicy;
  private readonly peer: WebSocketTakeoverPeer;
  private readonly lease: WebSocketTakeoverLease;
  private readonly onInput: ExperimentalWebSocketTakeoverOptions["onInput"];
  private readonly onClientDiagnostic: ExperimentalWebSocketTakeoverOptions["onClientDiagnostic"];
  private readonly maxInboundBytes: number;
  private readonly maxFrameBytes: number;
  private readonly maxBufferedBytes: number;
  private stateValue: WebSocketTakeoverState = "open";
  private operationTail: Promise<void> = Promise.resolve();
  private frameSending = false;
  private pendingFrame: WebSocketTakeoverFrame | undefined;
  private released = false;
  private doneStarted = false;
  private drainTimer: ReturnType<typeof setTimeout> | undefined;
  private sentFramesValue = 0;
  private droppedFramesValue = 0;
  private lastFailureValue?: WebSocketTakeoverFailureCode;
  private lastInputStageValue: WebSocketTakeoverInputStage = "none";

  constructor(options: ExperimentalWebSocketTakeoverOptions) {
    validateBinding(options.binding);
    this.binding = { ...options.binding };
    this.inputPolicy = { ...options.inputPolicy };
    this.peer = options.peer;
    this.lease = options.lease;
    this.onInput = options.onInput;
    this.onClientDiagnostic = options.onClientDiagnostic;
    this.maxInboundBytes = boundedLimit(
      options.maxInboundBytes,
      DEFAULT_MAX_INBOUND_BYTES,
      ABSOLUTE_MAX_INBOUND_BYTES,
      "maxInboundBytes"
    );
    this.maxFrameBytes = boundedLimit(
      options.maxFrameBytes,
      DEFAULT_MAX_FRAME_BYTES,
      ABSOLUTE_MAX_FRAME_BYTES,
      "maxFrameBytes"
    );
    this.maxBufferedBytes = boundedLimit(
      options.maxBufferedBytes,
      DEFAULT_MAX_BUFFERED_BYTES,
      ABSOLUTE_MAX_BUFFERED_BYTES,
      "maxBufferedBytes"
    );
  }

  get state(): WebSocketTakeoverState {
    return this.stateValue;
  }

  get diagnostics(): Readonly<{
    state: WebSocketTakeoverState;
    sentFrames: number;
    droppedFrames: number;
    lastFailure?: WebSocketTakeoverFailureCode;
    lastInputStage: WebSocketTakeoverInputStage;
  }> {
    return {
      state: this.stateValue,
      sentFrames: this.sentFramesValue,
      droppedFrames: this.droppedFramesValue,
      ...(this.lastFailureValue ? { lastFailure: this.lastFailureValue } : {}),
      lastInputStage: this.lastInputStageValue
    };
  }

  async start(): Promise<void> {
    if (this.stateValue !== "open") return;
    await this.runBoundUse(async () => {
      await this.peer.sendControl({ kind: "ready" });
    });
  }

  receiveText(raw: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.stateValue !== "open") return;
      let message: ReturnType<typeof parseHumanMessage>;
      try {
        message = parseHumanMessage(raw, this.maxInboundBytes, this.inputPolicy);
      } catch (error) {
        await this.failClosed(error);
        throw error;
      }

      if (message.kind === "diagnostic") {
        try { this.onClientDiagnostic?.(message.event); } catch { /* diagnostics are observe-only */ }
        return;
      }
      if (message.kind === "ping") {
        await this.runBoundUse(async () => {
          await this.peer.sendControl(
            message.nonce === undefined
              ? { kind: "pong" }
              : { kind: "pong", nonce: message.nonce }
          );
        });
        return;
      }
      if (message.kind === "done") {
        await this.complete();
        return;
      }
      this.lastInputStageValue = "received";
      await this.runBoundUse(
        async () => {
          this.lastInputStageValue = "dispatch_started";
          await this.onInput(message);
          this.lastInputStageValue = "dispatch_completed";
        },
        {
          onBeginReady: () => { this.lastInputStageValue = "authority_begin_ready"; },
          onEndReady: () => { this.lastInputStageValue = "authority_end_ready"; }
        }
      );
      this.lastInputStageValue = "applied";
    });
  }

  async pushFrame(frame: WebSocketTakeoverFrame): Promise<void> {
    if (this.stateValue !== "open") return;
    try {
      this.validateFrame(frame);
      if (this.frameSending || this.isBackpressured()) {
        this.replacePendingFrame(frame);
        this.scheduleDrain();
        return;
      }
    } catch (error) {
      await this.failClosed(error);
      throw error;
    }
    if (this.pendingFrame) {
      this.droppedFramesValue += 1;
      this.pendingFrame = undefined;
    }
    await this.sendFrameLoop(frame);
  }

  disconnect(): Promise<void> {
    return this.enqueue(async () => {
      if ((this.stateValue === "closed" || this.stateValue === "revoked") && this.released) {
        return;
      }
      this.stateValue = "closed";
      this.clearDrainTimer();
      this.pendingFrame = undefined;
      try {
        await this.releaseOnce();
      } catch (error) {
        this.recordReleaseFailure();
        await this.safeClose(INTERNAL_CLOSE, "authority_release_failed");
        throw error;
      }
    });
  }

  revoke(): Promise<void> {
    return this.enqueue(async () => {
      if ((this.stateValue === "revoked" || this.stateValue === "closed") && this.released) {
        return;
      }
      this.stateValue = "revoked";
      this.clearDrainTimer();
      this.pendingFrame = undefined;
      try {
        await this.releaseOnce();
      } catch (error) {
        this.recordReleaseFailure();
        await this.safeClose(INTERNAL_CLOSE, "authority_release_failed");
        throw error;
      }
      await this.safeClose(NORMAL_CLOSE, "revoked");
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.operationTail.then(operation, operation);
    this.operationTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async sendFrameLoop(first: WebSocketTakeoverFrame): Promise<void> {
    this.frameSending = true;
    let current: WebSocketTakeoverFrame | undefined = first;
    try {
      while (current && this.stateValue === "open") {
        if (this.isBackpressured()) {
          this.replacePendingFrame(current);
          this.scheduleDrain();
          break;
        }
        await this.runBoundUse(async () => {
          await this.peer.sendFrame(current!);
        });
        this.sentFramesValue += 1;
        current = this.pendingFrame;
        this.pendingFrame = undefined;
      }
    } catch (error) {
      await this.failClosed(
        error instanceof WebSocketTakeoverError
          ? error
          : new WebSocketTakeoverError("transport_failure", "WebSocket frame delivery failed")
      );
      throw error;
    } finally {
      this.frameSending = false;
    }
  }

  private async runBoundUse(
    operation: () => Promise<void>,
    stages?: { onBeginReady?: () => void; onEndReady?: () => void }
  ): Promise<void> {
    try {
      await this.lease.beginUse(this.binding);
      stages?.onBeginReady?.();
    } catch {
      const stale = new WebSocketTakeoverError(
        "stale_generation",
        "WebSocket takeover generation is no longer active"
      );
      await this.failClosed(stale);
      throw stale;
    }
    let operationError: unknown;
    try {
      await operation();
    } catch (error) {
      operationError = error;
    }

    try {
      await this.lease.endUse(this.binding);
      if (operationError === undefined) stages?.onEndReady?.();
    } catch {
      const stale = new WebSocketTakeoverError(
        "stale_generation",
        "WebSocket takeover generation ended while in use"
      );
      await this.failClosed(stale);
      throw stale;
    }

    if (operationError !== undefined) {
      await this.failClosed(
        new WebSocketTakeoverError("transport_failure", "WebSocket takeover operation failed")
      );
      throw operationError;
    }
  }

  private async complete(): Promise<void> {
    if (this.doneStarted || this.stateValue !== "open") return;
    this.doneStarted = true;
    this.stateValue = "closing";
    this.clearDrainTimer();
    this.pendingFrame = undefined;
    // Terminal UI delivery must not gate shared authority completion.
    this.notifyTerminal({ kind: "closing" });
    try {
      await this.lease.complete(this.binding);
      this.released = true;
      this.stateValue = "closed";
      this.notifyTerminal({ kind: "closed" });
      await this.safeClose(NORMAL_CLOSE, "done");
    } catch (error) {
      await this.failClosed(
        new WebSocketTakeoverError("stale_generation", "WebSocket completion was rejected")
      );
      throw error;
    }
  }

  private async failClosed(error: unknown): Promise<void> {
    const failure = error instanceof WebSocketTakeoverError
      ? error
      : new WebSocketTakeoverError("transport_failure", "WebSocket takeover transport failed");
    if (
      this.stateValue === "failed" ||
      this.stateValue === "closed" ||
      this.stateValue === "revoked"
    ) {
      return;
    }
    this.lastFailureValue = failure.code;
    this.stateValue = "failed";
    this.clearDrainTimer();
    this.pendingFrame = undefined;
    try {
      await this.releaseOnce();
    } catch {
      this.recordReleaseFailure();
    }
    this.notifyTerminal({ kind: "error", code: this.lastFailureValue ?? failure.code });
    await this.safeClose(
      failure.code === "transport_failure" || this.lastFailureValue === "authority_release_failed"
        ? INTERNAL_CLOSE
        : POLICY_CLOSE,
      this.lastFailureValue ?? failure.code
    );
  }

  private validateFrame(frame: WebSocketTakeoverFrame): void {
    if (
      !(frame.data instanceof Uint8Array) ||
      frame.data.byteLength < 1 ||
      frame.data.byteLength > this.maxFrameBytes ||
      !boundedInteger(frame.width, 1, 16_384) ||
      !boundedInteger(frame.height, 1, 16_384) ||
      (frame.mimeType !== "image/jpeg" && frame.mimeType !== "image/png")
    ) {
      throw new WebSocketTakeoverError("frame_too_large", "WebSocket takeover frame is invalid");
    }
  }

  private replacePendingFrame(frame: WebSocketTakeoverFrame): void {
    if (this.pendingFrame) this.droppedFramesValue += 1;
    this.pendingFrame = frame;
  }

  private scheduleDrain(): void {
    if (this.drainTimer || this.stateValue !== "open") return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      void this.flushPendingFrame();
    }, 20);
  }

  private async flushPendingFrame(): Promise<void> {
    if (
      this.stateValue !== "open" ||
      this.frameSending ||
      !this.pendingFrame
    ) {
      return;
    }
    try {
      if (this.isBackpressured()) {
        this.scheduleDrain();
        return;
      }
    } catch (error) {
      await this.failClosed(error);
      return;
    }
    const frame = this.pendingFrame;
    this.pendingFrame = undefined;
    try {
      await this.sendFrameLoop(frame);
    } catch {
      // sendFrameLoop already fenced the active transport.
    }
  }

  private isBackpressured(): boolean {
    let amount: number;
    try {
      amount = this.peer.bufferedAmount();
    } catch {
      throw new WebSocketTakeoverError(
        "transport_failure",
        "WebSocket buffered amount is unavailable"
      );
    }
    if (!boundedNumber(amount, 0, Number.MAX_SAFE_INTEGER)) {
      throw new WebSocketTakeoverError(
        "transport_failure",
        "WebSocket buffered amount is invalid"
      );
    }
    return amount > this.maxBufferedBytes;
  }

  private clearDrainTimer(): void {
    if (!this.drainTimer) return;
    clearTimeout(this.drainTimer);
    this.drainTimer = undefined;
  }

  private async releaseOnce(): Promise<void> {
    if (this.released) return;
    try {
      await this.lease.release(this.binding);
      this.released = true;
    } catch {
      throw new WebSocketTakeoverError(
        "authority_release_failed",
        "WebSocket takeover authority release failed"
      );
    }
  }

  private recordReleaseFailure(): void {
    this.released = false;
    this.stateValue = "failed";
    this.lastFailureValue = "authority_release_failed";
  }

  /** Terminal messages are finite, best-effort hints; late outcomes cannot change authority. */
  private notifyTerminal(
    message: Extract<WebSocketTakeoverServerMessage, { kind: "closing" | "closed" | "error" }>
  ): void {
    try {
      void Promise.resolve(this.peer.sendControl(message)).catch(() => undefined);
    } catch {
      // A synchronous peer failure is also independent of authority completion/release.
    }
  }

  private async safeClose(code: number, reason: string): Promise<void> {
    try {
      // Request closure now, but never hold the operation queue on a peer's close response.
      void Promise.resolve(this.peer.close(code, reason)).catch(() => undefined);
    } catch {
      // Local/shared authority state remains authoritative even if network cleanup fails.
    }
  }
}
