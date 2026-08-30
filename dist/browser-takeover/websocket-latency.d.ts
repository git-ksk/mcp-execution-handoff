export type WebSocketLatencyMetric = "capture" | "capture_prepare" | "capture_revalidate" | "capture_frame_wait" | "frame_send" | "frame_cadence" | "client_frame_decode" | "client_frame_cadence" | "input_apply" | "input_prepare" | "input_queue_wait" | "input_revalidate" | "input_host_ack" | "completion_fence" | "revoke_fence";
export interface WebSocketLatencyDistribution {
    count: number;
    p50Ms?: number;
    p95Ms?: number;
    maxMs?: number;
}
/**
 * Content-free WSS latency summary.
 *
 * Every value is a bounded duration observed within one clock domain. No raw timestamps,
 * frame bytes, input payloads, target identifiers, principal/session identifiers, network
 * addresses, URLs, credentials, or capabilities are retained.
 *
 * `captureFrameWait` is the same-process wait for the next post-revalidation JPEG frame to
 * become available. It can include frame cadence, capture/scale/encode, pipe, and parser time; it
 * is not a pure JPEG encode-duration measurement.
 *
 * `clientFrameDecode` is browser receive-to-`img.onload`, not compositor latency.
 * `clientFrameCadence` is spacing between those browser load completions. Neither field is a
 * cross-clock capture-to-display measurement.
 */
export interface WebSocketLatencySnapshot {
    samples: number;
    capture: WebSocketLatencyDistribution;
    capturePrepare: WebSocketLatencyDistribution;
    captureRevalidate: WebSocketLatencyDistribution;
    captureFrameWait: WebSocketLatencyDistribution;
    frameSend: WebSocketLatencyDistribution;
    frameCadence: WebSocketLatencyDistribution;
    clientFrameDecode: WebSocketLatencyDistribution;
    clientFrameCadence: WebSocketLatencyDistribution;
    inputApply: WebSocketLatencyDistribution;
    inputPrepare: WebSocketLatencyDistribution;
    inputQueueWait: WebSocketLatencyDistribution;
    inputRevalidate: WebSocketLatencyDistribution;
    inputHostAck: WebSocketLatencyDistribution;
    completionFence: WebSocketLatencyDistribution;
    revokeFence: WebSocketLatencyDistribution;
}
/** Bounded process-memory-only tracker for managed WSS performance acceptance. */
export declare class WebSocketLatencyTracker {
    #private;
    record(metric: WebSocketLatencyMetric, valueMs: number): void;
    snapshot(): WebSocketLatencySnapshot;
}
export declare function emptyWebSocketLatencySnapshot(): WebSocketLatencySnapshot;
export declare function isWebSocketClientLatencyMetric(value: unknown): value is "client_frame_decode" | "client_frame_cadence";
export declare function validWebSocketLatency(value: unknown): value is number;
//# sourceMappingURL=websocket-latency.d.ts.map