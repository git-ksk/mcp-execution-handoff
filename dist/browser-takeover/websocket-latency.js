const MAX_LATENCY_MS = 120_000;
const MAX_SAMPLES_PER_METRIC = 128;
const METRICS = [
    "capture",
    "frame_send",
    "frame_cadence",
    "client_frame_decode",
    "client_frame_cadence",
    "input_apply",
    "completion_fence",
    "revoke_fence"
];
/** Bounded process-memory-only tracker for managed WSS performance acceptance. */
export class WebSocketLatencyTracker {
    #samples = new Map(METRICS.map((metric) => [metric, []]));
    record(metric, valueMs) {
        if (!METRICS.includes(metric) || !validLatency(valueMs))
            return;
        const values = this.#samples.get(metric);
        values.push(roundMetric(valueMs));
        if (values.length > MAX_SAMPLES_PER_METRIC) {
            values.splice(0, values.length - MAX_SAMPLES_PER_METRIC);
        }
    }
    snapshot() {
        const capture = distribution(this.#samples.get("capture"));
        const frameSend = distribution(this.#samples.get("frame_send"));
        const frameCadence = distribution(this.#samples.get("frame_cadence"));
        const clientFrameDecode = distribution(this.#samples.get("client_frame_decode"));
        const clientFrameCadence = distribution(this.#samples.get("client_frame_cadence"));
        const inputApply = distribution(this.#samples.get("input_apply"));
        const completionFence = distribution(this.#samples.get("completion_fence"));
        const revokeFence = distribution(this.#samples.get("revoke_fence"));
        return {
            samples: capture.count
                + frameSend.count
                + frameCadence.count
                + clientFrameDecode.count
                + clientFrameCadence.count
                + inputApply.count
                + completionFence.count
                + revokeFence.count,
            capture,
            frameSend,
            frameCadence,
            clientFrameDecode,
            clientFrameCadence,
            inputApply,
            completionFence,
            revokeFence
        };
    }
}
export function emptyWebSocketLatencySnapshot() {
    return new WebSocketLatencyTracker().snapshot();
}
export function isWebSocketClientLatencyMetric(value) {
    return value === "client_frame_decode" || value === "client_frame_cadence";
}
export function validWebSocketLatency(value) {
    return validLatency(value);
}
function validLatency(value) {
    return typeof value === "number"
        && Number.isFinite(value)
        && value >= 0
        && value <= MAX_LATENCY_MS;
}
function roundMetric(value) {
    return Math.round(value * 10) / 10;
}
function distribution(values) {
    if (values.length === 0)
        return { count: 0 };
    const sorted = [...values].sort((left, right) => left - right);
    return {
        count: sorted.length,
        p50Ms: percentile(sorted, 0.50),
        p95Ms: percentile(sorted, 0.95),
        maxMs: sorted.at(-1)
    };
}
function percentile(sorted, percentileValue) {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentileValue) - 1));
    return sorted[index];
}
//# sourceMappingURL=websocket-latency.js.map