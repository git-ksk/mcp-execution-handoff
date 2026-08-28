export type WebSocketTakeoverState = "open" | "closing" | "closed" | "revoked" | "failed";
export type WebSocketTakeoverInputStage = "none" | "received" | "authority_begin_ready" | "dispatch_started" | "dispatch_completed" | "authority_end_ready" | "applied";
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
export type WebSocketTakeoverHumanInput = {
    kind: "tap";
    x: number;
    y: number;
} | {
    kind: "scroll";
    deltaY: number;
} | {
    kind: "text";
    text: string;
} | {
    kind: "key";
    key: string;
};
export interface WebSocketTakeoverFrame {
    data: Uint8Array;
    width: number;
    height: number;
    mimeType: "image/jpeg" | "image/png";
}
export type WebSocketTakeoverServerMessage = {
    kind: "ready";
} | {
    kind: "closing";
} | {
    kind: "closed";
} | {
    kind: "pong";
    nonce?: string;
} | {
    kind: "error";
    code: WebSocketTakeoverFailureCode;
};
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
    maxInboundBytes?: number;
    maxFrameBytes?: number;
    maxBufferedBytes?: number;
}
export type WebSocketTakeoverFailureCode = "invalid_message" | "input_not_allowed" | "stale_generation" | "frame_too_large" | "transport_failure" | "authority_release_failed";
export declare class WebSocketTakeoverError extends Error {
    readonly code: WebSocketTakeoverFailureCode;
    constructor(code: WebSocketTakeoverFailureCode, message: string);
}
export declare class ExperimentalWebSocketTakeoverChannel {
    private readonly binding;
    private readonly inputPolicy;
    private readonly peer;
    private readonly lease;
    private readonly onInput;
    private readonly maxInboundBytes;
    private readonly maxFrameBytes;
    private readonly maxBufferedBytes;
    private stateValue;
    private operationTail;
    private frameSending;
    private pendingFrame;
    private released;
    private doneStarted;
    private drainTimer;
    private sentFramesValue;
    private droppedFramesValue;
    private lastFailureValue?;
    private lastInputStageValue;
    constructor(options: ExperimentalWebSocketTakeoverOptions);
    get state(): WebSocketTakeoverState;
    get diagnostics(): Readonly<{
        state: WebSocketTakeoverState;
        sentFrames: number;
        droppedFrames: number;
        lastFailure?: WebSocketTakeoverFailureCode;
        lastInputStage: WebSocketTakeoverInputStage;
    }>;
    start(): Promise<void>;
    receiveText(raw: string): Promise<void>;
    pushFrame(frame: WebSocketTakeoverFrame): Promise<void>;
    disconnect(): Promise<void>;
    revoke(): Promise<void>;
    private enqueue;
    private sendFrameLoop;
    private runBoundUse;
    private complete;
    private failClosed;
    private validateFrame;
    private replacePendingFrame;
    private scheduleDrain;
    private flushPendingFrame;
    private isBackpressured;
    private clearDrainTimer;
    private releaseOnce;
    private recordReleaseFailure;
    private safeClose;
}
//# sourceMappingURL=websocket-takeover.d.ts.map