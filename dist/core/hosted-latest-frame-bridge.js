import { assertHostedOperatorBindingCurrent } from "./hosted-operator-binding.js";
export class HostedLatestFrameBridgeError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "HostedLatestFrameBridgeError";
    }
}
const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 512 * 1024;
const ABSOLUTE_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const ABSOLUTE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
function boundedLimit(value, fallback, maximum, name) {
    const resolved = value ?? fallback;
    if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
        throw new HostedLatestFrameBridgeError("HOSTED_FRAME_INVALID", `${name} is out of bounds`);
    }
    return resolved;
}
function validateFrame(frame, maxFrameBytes) {
    if (!(frame?.data instanceof Uint8Array)
        || frame.data.byteLength < 1
        || frame.data.byteLength > maxFrameBytes
        || !Number.isInteger(frame.width) || frame.width < 1 || frame.width > 16_384
        || !Number.isInteger(frame.height) || frame.height < 1 || frame.height > 16_384
        || (frame.mimeType !== "image/jpeg" && frame.mimeType !== "image/png")) {
        throw new HostedLatestFrameBridgeError("HOSTED_FRAME_INVALID", "Hosted frame is invalid");
    }
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
    #binding;
    #registry;
    #currentOperator;
    #peer;
    #maxFrameBytes;
    #maxBufferedBytes;
    #closed = false;
    #sending = false;
    #pending;
    #sentFrames = 0;
    #droppedFrames = 0;
    #backpressureEvents = 0;
    constructor(options) {
        this.#binding = {
            operator: { ...options.binding.operator },
            worker: { ...options.binding.worker }
        };
        this.#registry = options.registry;
        this.#currentOperator = options.currentOperator;
        this.#peer = options.peer;
        this.#maxFrameBytes = boundedLimit(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES, ABSOLUTE_MAX_FRAME_BYTES, "maxFrameBytes");
        this.#maxBufferedBytes = boundedLimit(options.maxBufferedBytes, DEFAULT_MAX_BUFFERED_BYTES, ABSOLUTE_MAX_BUFFERED_BYTES, "maxBufferedBytes");
    }
    diagnostics() {
        return {
            state: this.#closed ? "closed" : "open",
            sending: this.#sending,
            pending: this.#pending !== undefined,
            sentFrames: this.#sentFrames,
            droppedFrames: this.#droppedFrames,
            backpressureEvents: this.#backpressureEvents
        };
    }
    async publish(frame) {
        this.#assertOpen();
        validateFrame(frame, this.#maxFrameBytes);
        this.#assertCurrent();
        if (this.#sending || this.#isBackpressured()) {
            this.#replacePending(frame);
            return;
        }
        await this.#sendLoop(frame);
    }
    /** Call when the transport reports writable/drained state. */
    async drain() {
        this.#assertOpen();
        this.#assertCurrent();
        if (this.#sending || !this.#pending || this.#isBackpressured())
            return;
        const next = this.#pending;
        this.#pending = undefined;
        await this.#sendLoop(next);
    }
    close() {
        this.#closed = true;
        this.#pending = undefined;
    }
    #assertOpen() {
        if (this.#closed) {
            throw new HostedLatestFrameBridgeError("HOSTED_FRAME_BRIDGE_CLOSED", "Hosted frame bridge is closed");
        }
    }
    #assertCurrent() {
        assertHostedOperatorBindingCurrent(this.#binding, this.#currentOperator(), this.#registry);
    }
    #replacePending(frame) {
        if (this.#pending)
            this.#droppedFrames += 1;
        this.#pending = frame;
    }
    #isBackpressured() {
        let amount;
        try {
            amount = this.#peer.bufferedAmount();
        }
        catch {
            this.#failTransport();
        }
        if (!Number.isFinite(amount) || amount < 0 || amount > Number.MAX_SAFE_INTEGER) {
            this.#failTransport();
        }
        const backpressured = amount > this.#maxBufferedBytes;
        if (backpressured)
            this.#backpressureEvents += 1;
        return backpressured;
    }
    async #sendLoop(first) {
        this.#sending = true;
        let current = first;
        try {
            while (current && !this.#closed) {
                this.#assertCurrent();
                if (this.#isBackpressured()) {
                    this.#replacePending(current);
                    break;
                }
                try {
                    await this.#peer.sendFrame(current);
                }
                catch {
                    this.#failTransport();
                }
                this.#sentFrames += 1;
                current = this.#pending;
                this.#pending = undefined;
            }
        }
        finally {
            this.#sending = false;
        }
    }
    #failTransport() {
        this.#closed = true;
        this.#pending = undefined;
        throw new HostedLatestFrameBridgeError("HOSTED_FRAME_TRANSPORT_FAILURE", "Hosted frame transport failed");
    }
}
//# sourceMappingURL=hosted-latest-frame-bridge.js.map