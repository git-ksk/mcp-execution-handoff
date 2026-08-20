export type WebRtcNetworkPath = "direct" | "relay";
export interface WebRtcLatencySample {
    path: WebRtcNetworkPath;
    rttMs?: number;
    firstFrameMs?: number;
}
export interface WebRtcLatencyDistribution {
    count: number;
    p50Ms?: number;
    p95Ms?: number;
    maxMs?: number;
}
export interface WebRtcLatencyPathSummary {
    samples: number;
    rtt: WebRtcLatencyDistribution;
    firstFrame: WebRtcLatencyDistribution;
}
export interface WebRtcLatencyComparison {
    direct: WebRtcLatencyPathSummary;
    relay: WebRtcLatencyPathSummary;
}
/** Bounded, process-memory-only latency samples with no peer/network/credential identifiers. */
export declare class WebRtcLatencyTracker {
    private readonly samples;
    record(sample: WebRtcLatencySample): void;
    snapshot(): WebRtcLatencyComparison;
}
export declare function parseWebRtcLatencySample(value: unknown): WebRtcLatencySample | undefined;
//# sourceMappingURL=webrtc-latency.d.ts.map