import {
  assertHostedOperatorBindingCurrent,
  type HostedOperatorRouteBinding
} from "./hosted-operator-binding.js";
import type { HostedWorkerRegistry } from "./hosted-worker.js";

export type HostedFrameMimeType = "image/jpeg" | "image/png";

export interface HostedEphemeralFrame {
  data: Uint8Array;
  width: number;
  height: number;
  mimeType: HostedFrameMimeType;
}

export interface HostedFramePeer {
  sendFrame(frame: HostedEphemeralFrame): void | Promise<void>;
  bufferedAmount(): number;
}

export class HostedLatestFrameBridgeError extends Error {
  constructor(
    public readonly code:
      | "HOSTED_FRAME_INVALID"
      | "HOSTED_FRAME_BRIDGE_CLOSED"
      | "HOSTED_FRAME_TRANSPORT_FAILURE",
    message: string
  ) {
    super(message);
    this.name = "HostedLatestFrameBridgeError";
  }
}

export interface HostedLatestFrameBridgeOptions {
  binding: HostedOperatorRouteBinding;
  registry: HostedWorkerRegistry;
  currentOperator: () => unknown;
  peer: HostedFramePeer;
  maxFrameBytes?: number;
  maxBufferedBytes?: number;
}

const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 512 * 1024;
const ABSOLUTE_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const ABSOLUTE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

function boundedLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new HostedLatestFrameBridgeError(
      "HOSTED_FRAME_INVALID",
      `${name} is out of bounds`
    );
  }
  return resolved;
}

export function parseHostedEphemeralFrame(
  value: unknown,
  maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES
): HostedEphemeralFrame {
  const boundedMax = boundedLimit(
    maxFrameBytes,
    DEFAULT_MAX_FRAME_BYTES,
    ABSOLUTE_MAX_FRAME_BYTES,
    "maxFrameBytes"
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HostedLatestFrameBridgeError("HOSTED_FRAME_INVALID", "Hosted frame is invalid");
  }
  const frame = value as Partial<HostedEphemeralFrame> & Record<string, unknown>;
  const keys = Object.keys(frame);
  if (keys.length !== 4
    || !keys.every((key) => ["data", "width", "height", "mimeType"].includes(key))
    || !(frame.data instanceof Uint8Array)
    || frame.data.byteLength < 1
    || frame.data.byteLength > boundedMax
    || !Number.isInteger(frame.width) || Number(frame.width) < 1 || Number(frame.width) > 16_384
    || !Number.isInteger(frame.height) || Number(frame.height) < 1 || Number(frame.height) > 16_384
    || (frame.mimeType !== "image/jpeg" && frame.mimeType !== "image/png")) {
    throw new HostedLatestFrameBridgeError("HOSTED_FRAME_INVALID", "Hosted frame is invalid");
  }
  return {
    data: frame.data,
    width: frame.width as number,
    height: frame.height as number,
    mimeType: frame.mimeType
  };
}

/**
 * Process-memory latest-only bridge for hosted frame delivery.
 *
 * It intentionally holds at most one pending frame. When a send is in flight or the downstream
 * transport is backpressured, a newer frame replaces the older pending frame. No stale frame queue,
 * durable frame state, replay buffer, credential, or Human input exists here.
 *
 * The caller supplies the current operator reference; both operator/viewer generation and worker
 * route generation are revalidated immediately before each frame send.
 */
export class HostedLatestFrameBridge {
  readonly #binding: HostedOperatorRouteBinding;
  readonly #registry: HostedWorkerRegistry;
  readonly #currentOperator: () => unknown;
  readonly #peer: HostedFramePeer;
  readonly #maxFrameBytes: number;
  readonly #maxBufferedBytes: number;

  #closed = false;
  #sending = false;
  #pending: HostedEphemeralFrame | undefined;
  #sentFrames = 0;
  #droppedFrames = 0;
  #backpressureEvents = 0;

  constructor(options: HostedLatestFrameBridgeOptions) {
    this.#binding = {
      operator: { ...options.binding.operator },
      worker: { ...options.binding.worker }
    };
    this.#registry = options.registry;
    this.#currentOperator = options.currentOperator;
    this.#peer = options.peer;
    this.#maxFrameBytes = boundedLimit(
      options.maxFrameBytes,
      DEFAULT_MAX_FRAME_BYTES,
      ABSOLUTE_MAX_FRAME_BYTES,
      "maxFrameBytes"
    );
    this.#maxBufferedBytes = boundedLimit(
      options.maxBufferedBytes,
      DEFAULT_MAX_BUFFERED_BYTES,
      ABSOLUTE_MAX_BUFFERED_BYTES,
      "maxBufferedBytes"
    );
  }

  diagnostics(): Readonly<{
    state: "open" | "closed";
    sending: boolean;
    pending: boolean;
    sentFrames: number;
    droppedFrames: number;
    backpressureEvents: number;
  }> {
    return {
      state: this.#closed ? "closed" : "open",
      sending: this.#sending,
      pending: this.#pending !== undefined,
      sentFrames: this.#sentFrames,
      droppedFrames: this.#droppedFrames,
      backpressureEvents: this.#backpressureEvents
    };
  }

  async publish(frame: HostedEphemeralFrame): Promise<void> {
    this.#assertOpen();
    const parsedFrame = parseHostedEphemeralFrame(frame, this.#maxFrameBytes);
    this.#assertCurrent();

    if (this.#sending || this.#isBackpressured()) {
      this.#replacePending(parsedFrame);
      return;
    }
    await this.#sendLoop(parsedFrame);
  }

  /** Call when the transport reports writable/drained state. */
  async drain(): Promise<void> {
    this.#assertOpen();
    this.#assertCurrent();
    if (this.#sending || !this.#pending || this.#isBackpressured()) return;
    const next = this.#pending;
    this.#pending = undefined;
    await this.#sendLoop(next);
  }

  close(): void {
    this.#closed = true;
    this.#pending = undefined;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new HostedLatestFrameBridgeError(
        "HOSTED_FRAME_BRIDGE_CLOSED",
        "Hosted frame bridge is closed"
      );
    }
  }

  #assertCurrent(): void {
    assertHostedOperatorBindingCurrent(
      this.#binding,
      this.#currentOperator(),
      this.#registry
    );
  }

  #replacePending(frame: HostedEphemeralFrame): void {
    if (this.#pending) this.#droppedFrames += 1;
    this.#pending = frame;
  }

  #isBackpressured(): boolean {
    let amount: number;
    try {
      amount = this.#peer.bufferedAmount();
    } catch {
      this.#failTransport();
    }
    if (!Number.isFinite(amount!) || amount! < 0 || amount! > Number.MAX_SAFE_INTEGER) {
      this.#failTransport();
    }
    const backpressured = amount! > this.#maxBufferedBytes;
    if (backpressured) this.#backpressureEvents += 1;
    return backpressured;
  }

  async #sendLoop(first: HostedEphemeralFrame): Promise<void> {
    this.#sending = true;
    let current: HostedEphemeralFrame | undefined = first;
    try {
      while (current && !this.#closed) {
        this.#assertCurrent();
        if (this.#isBackpressured()) {
          this.#replacePending(current);
          break;
        }
        try {
          await this.#peer.sendFrame(current);
        } catch {
          this.#failTransport();
        }
        this.#sentFrames += 1;
        current = this.#pending;
        this.#pending = undefined;
      }
    } finally {
      this.#sending = false;
    }
  }

  #failTransport(): never {
    this.#closed = true;
    this.#pending = undefined;
    throw new HostedLatestFrameBridgeError(
      "HOSTED_FRAME_TRANSPORT_FAILURE",
      "Hosted frame transport failed"
    );
  }
}
