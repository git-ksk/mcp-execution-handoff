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

const MAX_LATENCY_MS = 120_000;
const MAX_SAMPLES = 128;

const BROWSER_LATENCY_FIELDS = [
  "rttMs", "firstFrameMs", "jitterMs", "jitterBufferMs", "jitterBufferTargetMs",
  "jitterBufferMinimumMs", "avgDecodeMs", "avgProcessingMs", "senderTimelineToDisplayMs",
  "senderTimelineToReceiveMs", "receiveToDisplayMs", "frameDecodeMs", "compositorMs", "inputAckMs"
] as const;

const SERVER_LATENCY_FIELDS = ["hostEncodeMs", "rtpDrainMs"] as const;
const LATENCY_FIELDS = [...BROWSER_LATENCY_FIELDS, ...SERVER_LATENCY_FIELDS] as const;

/** Bounded, process-memory-only latency samples with no peer/network/credential identifiers. */
export class WebRtcLatencyTracker {
  private readonly samples: WebRtcLatencySample[] = [];

  record(sample: WebRtcLatencySample): void {
    const normalized = normalizeLatencySample(sample);
    if (!normalized) return;
    this.samples.push(normalized);
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);
  }

  snapshot(): WebRtcLatencyComparison {
    return {
      direct: summarize(this.samples.filter((sample) => sample.path === "direct")),
      relay: summarize(this.samples.filter((sample) => sample.path === "relay"))
    };
  }
}

/** Parse only receiver/browser-observable metrics. Server-only stage timings are added after this boundary. */
export function parseWebRtcLatencySample(value: unknown): WebRtcLatencySample | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const allowed = new Set<string>(["path", ...BROWSER_LATENCY_FIELDS]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return undefined;
  if (record.path !== "direct" && record.path !== "relay") return undefined;
  const candidate: WebRtcLatencySample = { path: record.path };
  for (const key of BROWSER_LATENCY_FIELDS) {
    const field = record[key];
    if (field === undefined) continue;
    if (!validLatency(field)) return undefined;
    candidate[key] = roundMetric(field);
  }
  return normalizeLatencySample(candidate);
}

function normalizeLatencySample(sample: WebRtcLatencySample): WebRtcLatencySample | undefined {
  if (sample.path !== "direct" && sample.path !== "relay") return undefined;
  if (LATENCY_FIELDS.every((key) => sample[key] === undefined)) return undefined;
  for (const key of LATENCY_FIELDS) {
    const value = sample[key];
    if (value !== undefined && !validLatency(value)) return undefined;
  }
  const normalized: WebRtcLatencySample = { path: sample.path };
  for (const key of LATENCY_FIELDS) {
    const value = sample[key];
    if (value !== undefined) normalized[key] = roundMetric(value);
  }
  return normalized;
}

function validLatency(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_LATENCY_MS;
}

function roundMetric(value: number): number {
  return Math.round(value * 10) / 10;
}

function summarize(samples: readonly WebRtcLatencySample[]): WebRtcLatencyPathSummary {
  return {
    samples: samples.length,
    rtt: distribution(samples.flatMap((sample) => sample.rttMs === undefined ? [] : [sample.rttMs])),
    firstFrame: distribution(samples.flatMap((sample) => sample.firstFrameMs === undefined ? [] : [sample.firstFrameMs])),
    jitter: distribution(samples.flatMap((sample) => sample.jitterMs === undefined ? [] : [sample.jitterMs])),
    jitterBuffer: distribution(samples.flatMap((sample) => sample.jitterBufferMs === undefined ? [] : [sample.jitterBufferMs])),
    jitterBufferTarget: distribution(samples.flatMap((sample) => sample.jitterBufferTargetMs === undefined ? [] : [sample.jitterBufferTargetMs])),
    jitterBufferMinimum: distribution(samples.flatMap((sample) => sample.jitterBufferMinimumMs === undefined ? [] : [sample.jitterBufferMinimumMs])),
    avgDecode: distribution(samples.flatMap((sample) => sample.avgDecodeMs === undefined ? [] : [sample.avgDecodeMs])),
    avgProcessing: distribution(samples.flatMap((sample) => sample.avgProcessingMs === undefined ? [] : [sample.avgProcessingMs])),
    senderTimelineToDisplay: distribution(samples.flatMap((sample) => sample.senderTimelineToDisplayMs === undefined ? [] : [sample.senderTimelineToDisplayMs])),
    senderTimelineToReceive: distribution(samples.flatMap((sample) => sample.senderTimelineToReceiveMs === undefined ? [] : [sample.senderTimelineToReceiveMs])),
    receiveToDisplay: distribution(samples.flatMap((sample) => sample.receiveToDisplayMs === undefined ? [] : [sample.receiveToDisplayMs])),
    frameDecode: distribution(samples.flatMap((sample) => sample.frameDecodeMs === undefined ? [] : [sample.frameDecodeMs])),
    compositor: distribution(samples.flatMap((sample) => sample.compositorMs === undefined ? [] : [sample.compositorMs])),
    inputAck: distribution(samples.flatMap((sample) => sample.inputAckMs === undefined ? [] : [sample.inputAckMs])),
    hostEncode: distribution(samples.flatMap((sample) => sample.hostEncodeMs === undefined ? [] : [sample.hostEncodeMs])),
    rtpDrain: distribution(samples.flatMap((sample) => sample.rtpDrainMs === undefined ? [] : [sample.rtpDrainMs]))
  };
}

function distribution(values: number[]): WebRtcLatencyDistribution {
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
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentileValue) - 1));
  return sorted[index]!;
}
