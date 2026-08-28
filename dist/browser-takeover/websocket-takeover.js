export class WebSocketTakeoverError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
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
function boundedInteger(value, min, max) {
    return Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
}
function boundedNumber(value, min, max) {
    return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
function utf8Length(value) {
    return new TextEncoder().encode(value).byteLength;
}
function boundedString(value, maxBytes) {
    return typeof value === "string" && utf8Length(value) <= maxBytes;
}
function hasOnlyKeys(record, allowed) {
    const keys = Object.keys(record);
    return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}
function validateBinding(binding) {
    if (!binding.interventionId ||
        !boundedInteger(binding.epoch, 0, Number.MAX_SAFE_INTEGER) ||
        !binding.principalBinding ||
        !binding.clientBinding ||
        !boundedInteger(binding.clientGeneration, 1, Number.MAX_SAFE_INTEGER)) {
        throw new Error("websocket takeover requires one exact active session binding");
    }
}
function boundedLimit(value, fallback, maximum, name) {
    const resolved = value ?? fallback;
    if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
        throw new Error(`${name} must be an integer between 1 and ${maximum}`);
    }
    return resolved;
}
function parseHumanMessage(raw, maxInboundBytes, inputPolicy) {
    if (utf8Length(raw) > maxInboundBytes) {
        throw new WebSocketTakeoverError("invalid_message", "WebSocket takeover message is too large");
    }
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw new WebSocketTakeoverError("invalid_message", "WebSocket takeover message is invalid JSON");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new WebSocketTakeoverError("invalid_message", "WebSocket takeover message must be an object");
    }
    const record = value;
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
    binding;
    inputPolicy;
    peer;
    lease;
    onInput;
    maxInboundBytes;
    maxFrameBytes;
    maxBufferedBytes;
    stateValue = "open";
    operationTail = Promise.resolve();
    frameSending = false;
    pendingFrame;
    released = false;
    doneStarted = false;
    drainTimer;
    sentFramesValue = 0;
    droppedFramesValue = 0;
    lastFailureValue;
    lastInputStageValue = "none";
    constructor(options) {
        validateBinding(options.binding);
        this.binding = { ...options.binding };
        this.inputPolicy = { ...options.inputPolicy };
        this.peer = options.peer;
        this.lease = options.lease;
        this.onInput = options.onInput;
        this.maxInboundBytes = boundedLimit(options.maxInboundBytes, DEFAULT_MAX_INBOUND_BYTES, ABSOLUTE_MAX_INBOUND_BYTES, "maxInboundBytes");
        this.maxFrameBytes = boundedLimit(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES, ABSOLUTE_MAX_FRAME_BYTES, "maxFrameBytes");
        this.maxBufferedBytes = boundedLimit(options.maxBufferedBytes, DEFAULT_MAX_BUFFERED_BYTES, ABSOLUTE_MAX_BUFFERED_BYTES, "maxBufferedBytes");
    }
    get state() {
        return this.stateValue;
    }
    get diagnostics() {
        return {
            state: this.stateValue,
            sentFrames: this.sentFramesValue,
            droppedFrames: this.droppedFramesValue,
            ...(this.lastFailureValue ? { lastFailure: this.lastFailureValue } : {}),
            lastInputStage: this.lastInputStageValue
        };
    }
    async start() {
        if (this.stateValue !== "open")
            return;
        await this.runBoundUse(async () => {
            await this.peer.sendControl({ kind: "ready" });
        });
    }
    receiveText(raw) {
        return this.enqueue(async () => {
            if (this.stateValue !== "open")
                return;
            let message;
            try {
                message = parseHumanMessage(raw, this.maxInboundBytes, this.inputPolicy);
            }
            catch (error) {
                await this.failClosed(error);
                throw error;
            }
            if (message.kind === "ping") {
                await this.runBoundUse(async () => {
                    await this.peer.sendControl(message.nonce === undefined
                        ? { kind: "pong" }
                        : { kind: "pong", nonce: message.nonce });
                });
                return;
            }
            if (message.kind === "done") {
                await this.complete();
                return;
            }
            this.lastInputStageValue = "received";
            await this.runBoundUse(async () => {
                this.lastInputStageValue = "dispatch_started";
                await this.onInput(message);
                this.lastInputStageValue = "dispatch_completed";
            }, {
                onBeginReady: () => { this.lastInputStageValue = "authority_begin_ready"; },
                onEndReady: () => { this.lastInputStageValue = "authority_end_ready"; }
            });
            this.lastInputStageValue = "applied";
        });
    }
    async pushFrame(frame) {
        if (this.stateValue !== "open")
            return;
        try {
            this.validateFrame(frame);
            if (this.frameSending || this.isBackpressured()) {
                this.replacePendingFrame(frame);
                this.scheduleDrain();
                return;
            }
        }
        catch (error) {
            await this.failClosed(error);
            throw error;
        }
        if (this.pendingFrame) {
            this.droppedFramesValue += 1;
            this.pendingFrame = undefined;
        }
        await this.sendFrameLoop(frame);
    }
    disconnect() {
        return this.enqueue(async () => {
            if ((this.stateValue === "closed" || this.stateValue === "revoked") && this.released) {
                return;
            }
            this.stateValue = "closed";
            this.clearDrainTimer();
            this.pendingFrame = undefined;
            try {
                await this.releaseOnce();
            }
            catch (error) {
                this.recordReleaseFailure();
                await this.safeClose(INTERNAL_CLOSE, "authority_release_failed");
                throw error;
            }
        });
    }
    revoke() {
        return this.enqueue(async () => {
            if ((this.stateValue === "revoked" || this.stateValue === "closed") && this.released) {
                return;
            }
            this.stateValue = "revoked";
            this.clearDrainTimer();
            this.pendingFrame = undefined;
            try {
                await this.releaseOnce();
            }
            catch (error) {
                this.recordReleaseFailure();
                await this.safeClose(INTERNAL_CLOSE, "authority_release_failed");
                throw error;
            }
            await this.safeClose(NORMAL_CLOSE, "revoked");
        });
    }
    enqueue(operation) {
        const run = this.operationTail.then(operation, operation);
        this.operationTail = run.then(() => undefined, () => undefined);
        return run;
    }
    async sendFrameLoop(first) {
        this.frameSending = true;
        let current = first;
        try {
            while (current && this.stateValue === "open") {
                if (this.isBackpressured()) {
                    this.replacePendingFrame(current);
                    this.scheduleDrain();
                    break;
                }
                await this.runBoundUse(async () => {
                    await this.peer.sendFrame(current);
                });
                this.sentFramesValue += 1;
                current = this.pendingFrame;
                this.pendingFrame = undefined;
            }
        }
        catch (error) {
            await this.failClosed(error instanceof WebSocketTakeoverError
                ? error
                : new WebSocketTakeoverError("transport_failure", "WebSocket frame delivery failed"));
            throw error;
        }
        finally {
            this.frameSending = false;
        }
    }
    async runBoundUse(operation, stages) {
        try {
            await this.lease.beginUse(this.binding);
            stages?.onBeginReady?.();
        }
        catch {
            const stale = new WebSocketTakeoverError("stale_generation", "WebSocket takeover generation is no longer active");
            await this.failClosed(stale);
            throw stale;
        }
        let operationError;
        try {
            await operation();
        }
        catch (error) {
            operationError = error;
        }
        try {
            await this.lease.endUse(this.binding);
            if (operationError === undefined)
                stages?.onEndReady?.();
        }
        catch {
            const stale = new WebSocketTakeoverError("stale_generation", "WebSocket takeover generation ended while in use");
            await this.failClosed(stale);
            throw stale;
        }
        if (operationError !== undefined) {
            await this.failClosed(new WebSocketTakeoverError("transport_failure", "WebSocket takeover operation failed"));
            throw operationError;
        }
    }
    async complete() {
        if (this.doneStarted || this.stateValue !== "open")
            return;
        this.doneStarted = true;
        this.stateValue = "closing";
        this.clearDrainTimer();
        this.pendingFrame = undefined;
        try {
            await this.peer.sendControl({ kind: "closing" });
        }
        catch (error) {
            await this.failClosed(new WebSocketTakeoverError("transport_failure", "WebSocket completion signaling failed"));
            throw error;
        }
        try {
            await this.lease.complete(this.binding);
            this.released = true;
            this.stateValue = "closed";
            await this.peer.sendControl({ kind: "closed" });
            await this.safeClose(NORMAL_CLOSE, "done");
        }
        catch (error) {
            await this.failClosed(new WebSocketTakeoverError("stale_generation", "WebSocket completion was rejected"));
            throw error;
        }
    }
    async failClosed(error) {
        const failure = error instanceof WebSocketTakeoverError
            ? error
            : new WebSocketTakeoverError("transport_failure", "WebSocket takeover transport failed");
        if (this.stateValue === "failed" ||
            this.stateValue === "closed" ||
            this.stateValue === "revoked") {
            return;
        }
        this.lastFailureValue = failure.code;
        this.stateValue = "failed";
        this.clearDrainTimer();
        this.pendingFrame = undefined;
        try {
            await this.peer.sendControl({ kind: "error", code: failure.code });
        }
        catch {
            // The connection may already be unavailable. Authority is still fenced below.
        }
        try {
            await this.releaseOnce();
        }
        catch {
            this.recordReleaseFailure();
        }
        await this.safeClose(failure.code === "transport_failure" || this.lastFailureValue === "authority_release_failed"
            ? INTERNAL_CLOSE
            : POLICY_CLOSE, this.lastFailureValue ?? failure.code);
    }
    validateFrame(frame) {
        if (!(frame.data instanceof Uint8Array) ||
            frame.data.byteLength < 1 ||
            frame.data.byteLength > this.maxFrameBytes ||
            !boundedInteger(frame.width, 1, 16_384) ||
            !boundedInteger(frame.height, 1, 16_384) ||
            (frame.mimeType !== "image/jpeg" && frame.mimeType !== "image/png")) {
            throw new WebSocketTakeoverError("frame_too_large", "WebSocket takeover frame is invalid");
        }
    }
    replacePendingFrame(frame) {
        if (this.pendingFrame)
            this.droppedFramesValue += 1;
        this.pendingFrame = frame;
    }
    scheduleDrain() {
        if (this.drainTimer || this.stateValue !== "open")
            return;
        this.drainTimer = setTimeout(() => {
            this.drainTimer = undefined;
            void this.flushPendingFrame();
        }, 20);
    }
    async flushPendingFrame() {
        if (this.stateValue !== "open" ||
            this.frameSending ||
            !this.pendingFrame) {
            return;
        }
        try {
            if (this.isBackpressured()) {
                this.scheduleDrain();
                return;
            }
        }
        catch (error) {
            await this.failClosed(error);
            return;
        }
        const frame = this.pendingFrame;
        this.pendingFrame = undefined;
        try {
            await this.sendFrameLoop(frame);
        }
        catch {
            // sendFrameLoop already fenced the active transport.
        }
    }
    isBackpressured() {
        let amount;
        try {
            amount = this.peer.bufferedAmount();
        }
        catch {
            throw new WebSocketTakeoverError("transport_failure", "WebSocket buffered amount is unavailable");
        }
        if (!boundedNumber(amount, 0, Number.MAX_SAFE_INTEGER)) {
            throw new WebSocketTakeoverError("transport_failure", "WebSocket buffered amount is invalid");
        }
        return amount > this.maxBufferedBytes;
    }
    clearDrainTimer() {
        if (!this.drainTimer)
            return;
        clearTimeout(this.drainTimer);
        this.drainTimer = undefined;
    }
    async releaseOnce() {
        if (this.released)
            return;
        try {
            await this.lease.release(this.binding);
            this.released = true;
        }
        catch {
            throw new WebSocketTakeoverError("authority_release_failed", "WebSocket takeover authority release failed");
        }
    }
    recordReleaseFailure() {
        this.released = false;
        this.stateValue = "failed";
        this.lastFailureValue = "authority_release_failed";
    }
    async safeClose(code, reason) {
        try {
            await this.peer.close(code, reason);
        }
        catch {
            // Closing the network connection is best-effort after authority has been fenced.
        }
    }
}
//# sourceMappingURL=websocket-takeover.js.map