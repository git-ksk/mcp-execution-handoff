export type WebSocketLatencyMetric =
  | "capture"
  | "capture_prepare"
  | "capture_revalidate"
  | "capture_frame_wait"
  | "frame_send"
  | "frame_cadence"
  | "client_frame_decode"
  | "client_frame_cadence"
  | "client_first_frame"
  | "client_first_ready"
  | "client_ready_to_first_frame"
  | "client_reconnect_frame"
  | "client_reconnect_ready"
  | "input_apply"
  | "input_prepare"
  | "input_queue_wait"
  | "input_revalidate"
  | "input_host_ack"
  | "completion_fence"
  | "revoke_fence";

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
 * `clientFrameCadence` is spacing between those browser load completions. `clientFirstFrame` is
 * initial client connect start-to-first-`img.onload`; `clientFirstReady` is initial connect start to
 * fresh WSS `ready`; `clientReadyToFirstFrame` is that `ready` to first `img.onload`. Together they
 * separate transport/control-plane readiness from post-ready capture/decode startup. `clientReconnectFrame` is managed WSS
 * disconnect detection-to-first post-reconnect `img.onload`; `clientReconnectReady` is managed
 * WSS disconnect detection-to-fresh-generation `ready`. All client metrics use only the
 * browser clock and none are cross-clock capture-to-display or compositor measurements.
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
  clientFirstFrame: WebSocketLatencyDistribution;
  clientFirstReady: WebSocketLatencyDistribution;
  clientReadyToFirstFrame: WebSocketLatencyDistribution;
  clientReconnectFrame: WebSocketLatencyDistribution;
  clientReconnectReady: WebSocketLatencyDistribution;
  inputApply: WebSocketLatencyDistribution;
  inputPrepare: WebSocketLatencyDistribution;
  inputQueueWait: WebSocketLatencyDistribution;
  inputRevalidate: WebSocketLatencyDistribution;
  inputHostAck: WebSocketLatencyDistribution;
  completionFence: WebSocketLatencyDistribution;
  revokeFence: WebSocketLatencyDistribution;
}

const MAX_LATENCY_MS = 120_000;
const MAX_SAMPLES_PER_METRIC = 128;

const METRICS = [
  "capture",
  "capture_prepare",
  "capture_revalidate",
  "capture_frame_wait",
  "frame_send",
  "frame_cadence",
  "client_frame_decode",
  "client_frame_cadence",
  "client_first_frame",
  "client_first_ready",
  "client_ready_to_first_frame",
  "client_reconnect_frame",
  "client_reconnect_ready",
  "input_apply",
  "input_prepare",
  "input_queue_wait",
  "input_revalidate",
  "input_host_ack",
  "completion_fence",
  "revoke_fence"
] as const satisfies readonly WebSocketLatencyMetric[];

/** Bounded process-memory-only tracker for managed WSS performance acceptance. */
export class WebSocketLatencyTracker {
  readonly #samples = new Map<WebSocketLatencyMetric, number[]>(
    METRICS.map((metric) => [metric, []])
  );

  record(metric: WebSocketLatencyMetric, valueMs: number): void {
    if (!METRICS.includes(metric) || !validLatency(valueMs)) return;
    const values = this.#samples.get(metric)!;
    values.push(roundMetric(valueMs));
    if (values.length > MAX_SAMPLES_PER_METRIC) {
      values.splice(0, values.length - MAX_SAMPLES_PER_METRIC);
    }
  }

  snapshot(): WebSocketLatencySnapshot {
    const capture = distribution(this.#samples.get("capture")!);
    const capturePrepare = distribution(this.#samples.get("capture_prepare")!);
    const captureRevalidate = distribution(this.#samples.get("capture_revalidate")!);
    const captureFrameWait = distribution(this.#samples.get("capture_frame_wait")!);
    const frameSend = distribution(this.#samples.get("frame_send")!);
    const frameCadence = distribution(this.#samples.get("frame_cadence")!);
    const clientFrameDecode = distribution(this.#samples.get("client_frame_decode")!);
    const clientFrameCadence = distribution(this.#samples.get("client_frame_cadence")!);
    const clientFirstFrame = distribution(this.#samples.get("client_first_frame")!);
    const clientFirstReady = distribution(this.#samples.get("client_first_ready")!);
    const clientReadyToFirstFrame = distribution(this.#samples.get("client_ready_to_first_frame")!);
    const clientReconnectFrame = distribution(this.#samples.get("client_reconnect_frame")!);
    const clientReconnectReady = distribution(this.#samples.get("client_reconnect_ready")!);
    const inputApply = distribution(this.#samples.get("input_apply")!);
    const inputPrepare = distribution(this.#samples.get("input_prepare")!);
    const inputQueueWait = distribution(this.#samples.get("input_queue_wait")!);
    const inputRevalidate = distribution(this.#samples.get("input_revalidate")!);
    const inputHostAck = distribution(this.#samples.get("input_host_ack")!);
    const completionFence = distribution(this.#samples.get("completion_fence")!);
    const revokeFence = distribution(this.#samples.get("revoke_fence")!);
    return {
      samples: capture.count
        + capturePrepare.count
        + captureRevalidate.count
        + captureFrameWait.count
        + frameSend.count
        + frameCadence.count
        + clientFrameDecode.count
        + clientFrameCadence.count
        + clientFirstFrame.count
        + clientFirstReady.count
        + clientReadyToFirstFrame.count
        + clientReconnectFrame.count
        + clientReconnectReady.count
        + inputApply.count
        + inputPrepare.count
        + inputQueueWait.count
        + inputRevalidate.count
        + inputHostAck.count
        + completionFence.count
        + revokeFence.count,
      capture,
      capturePrepare,
      captureRevalidate,
      captureFrameWait,
      frameSend,
      frameCadence,
      clientFrameDecode,
      clientFrameCadence,
      clientFirstFrame,
      clientFirstReady,
      clientReadyToFirstFrame,
      clientReconnectFrame,
      clientReconnectReady,
      inputApply,
      inputPrepare,
      inputQueueWait,
      inputRevalidate,
      inputHostAck,
      completionFence,
      revokeFence
    };
  }
}

export function emptyWebSocketLatencySnapshot(): WebSocketLatencySnapshot {
  return new WebSocketLatencyTracker().snapshot();
}

export function isWebSocketClientLatencyMetric(
  value: unknown
): value is "client_frame_decode" | "client_frame_cadence" | "client_first_frame" | "client_first_ready" | "client_ready_to_first_frame" | "client_reconnect_frame" | "client_reconnect_ready" {
  return value === "client_frame_decode"
    || value === "client_frame_cadence"
    || value === "client_first_frame"
    || value === "client_first_ready"
    || value === "client_ready_to_first_frame"
    || value === "client_reconnect_frame"
    || value === "client_reconnect_ready";
}

export function validWebSocketLatency(value: unknown): value is number {
  return validLatency(value);
}

function validLatency(value: unknown): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    && value <= MAX_LATENCY_MS;
}

function roundMetric(value: number): number {
  return Math.round(value * 10) / 10;
}

function distribution(values: readonly number[]): WebSocketLatencyDistribution {
  if (values.length === 0) return { count: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50Ms: percentile(sorted, 0.50),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1)!
  };
}

function percentile(sorted: readonly number[], percentileValue: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)
  );
  return sorted[index]!;
}
