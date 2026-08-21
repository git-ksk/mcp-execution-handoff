export type WebRtcNetworkPath = "direct" | "relay";
export interface WebRtcLatencySample {
    path: WebRtcNetworkPath;
    rttMs?: number;
    firstFrameMs?: number;
    jitterMs?: number;
    jitterBufferMs?: number;
    jitterBufferTargetMs?: number;
    jitterBufferMinimumMs?: number;
    avgDecodeMs?: number;
    avgProcessingMs?: number;
    /** Browser WebRTC remote RTP/RTCP sender timeline estimate to expected display, not ScreenCaptureKit capture age. */
    senderTimelineToDisplayMs?: number;
    /** Browser WebRTC remote RTP/RTCP sender timeline estimate to receive, not ScreenCaptureKit capture-to-receive. */
    senderTimelineToReceiveMs?: number;
    receiveToDisplayMs?: number;
    frameDecodeMs?: number;
    compositorMs?: number;
    inputAckMs?: number;
    /** Server-side helper encode submission through normalized AVCC output. Never accepted from the browser metrics payload. */
    hostEncodeMs?: number;
    /** Server-side time spent packetizing and awaiting RTP sends for one fully-sent frame. Never accepted from the browser payload. */
    rtpDrainMs?: number;
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
    jitter: WebRtcLatencyDistribution;
    jitterBuffer: WebRtcLatencyDistribution;
    jitterBufferTarget: WebRtcLatencyDistribution;
    jitterBufferMinimum: WebRtcLatencyDistribution;
    avgDecode: WebRtcLatencyDistribution;
    avgProcessing: WebRtcLatencyDistribution;
    senderTimelineToDisplay: WebRtcLatencyDistribution;
    senderTimelineToReceive: WebRtcLatencyDistribution;
    receiveToDisplay: WebRtcLatencyDistribution;
    frameDecode: WebRtcLatencyDistribution;
    compositor: WebRtcLatencyDistribution;
    inputAck: WebRtcLatencyDistribution;
    hostEncode: WebRtcLatencyDistribution;
    rtpDrain: WebRtcLatencyDistribution;
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
/** Parse only receiver/browser-observable metrics. Server-only stage timings are added after this boundary. */
export declare function parseWebRtcLatencySample(value: unknown): WebRtcLatencySample | undefined;
//# sourceMappingURL=webrtc-latency.d.ts.map