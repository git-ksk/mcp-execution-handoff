import { type HostedOperatorRouteBinding } from "./hosted-operator-binding.js";
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
export declare class HostedLatestFrameBridgeError extends Error {
    readonly code: "HOSTED_FRAME_INVALID" | "HOSTED_FRAME_BRIDGE_CLOSED" | "HOSTED_FRAME_TRANSPORT_FAILURE";
    constructor(code: "HOSTED_FRAME_INVALID" | "HOSTED_FRAME_BRIDGE_CLOSED" | "HOSTED_FRAME_TRANSPORT_FAILURE", message: string);
}
export interface HostedLatestFrameBridgeOptions {
    binding: HostedOperatorRouteBinding;
    registry: HostedWorkerRegistry;
    currentOperator: () => unknown;
    peer: HostedFramePeer;
    maxFrameBytes?: number;
    maxBufferedBytes?: number;
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
export declare class HostedLatestFrameBridge {
    #private;
    constructor(options: HostedLatestFrameBridgeOptions);
    diagnostics(): Readonly<{
        state: "open" | "closed";
        sending: boolean;
        pending: boolean;
        sentFrames: number;
        droppedFrames: number;
        backpressureEvents: number;
    }>;
    publish(frame: HostedEphemeralFrame): Promise<void>;
    /** Call when the transport reports writable/drained state. */
    drain(): Promise<void>;
    close(): void;
}
//# sourceMappingURL=hosted-latest-frame-bridge.d.ts.map