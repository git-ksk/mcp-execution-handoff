export type WebSocketLatencyMetric = "capture" | "frame_send" | "frame_cadence" | "client_frame_decode" | "client_frame_cadence" | "input_apply" | "completion_fence" | "revoke_fence";
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
 * `clientFrameDecode` is browser receive-to-`img.onload`, not compositor latency.
 * `clientFrameCadence` is spacing between those browser load completions. Neither field is a
 * cross-clock capture-to-display measurement.
 */
export interface WebSocketLatencySnapshot {
    samples: number;
    capture: WebSocketLatencyDistribution;
    frameSend: WebSocketLatencyDistribution;
    frameCadence: WebSocketLatencyDistribution;
    clientFrameDecode: WebSocketLatencyDistribution;
    clientFrameCadence: WebSocketLatencyDistribution;
    inputApply: WebSocketLatencyDistribution;
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