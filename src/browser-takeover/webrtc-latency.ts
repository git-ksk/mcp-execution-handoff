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

const MAX_LATENCY_MS = 120_000;
const MAX_SAMPLES = 128;

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

export function parseWebRtcLatencySample(value: unknown): WebRtcLatencySample | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== "path" && key !== "rttMs" && key !== "firstFrameMs")) return undefined;
  if (record.path !== "direct" && record.path !== "relay") return undefined;
  const candidate: WebRtcLatencySample = { path: record.path };
  if (record.rttMs !== undefined) {
    if (!validLatency(record.rttMs)) return undefined;
    candidate.rttMs = roundMetric(record.rttMs);
  }
  if (record.firstFrameMs !== undefined) {
    if (!validLatency(record.firstFrameMs)) return undefined;
    candidate.firstFrameMs = roundMetric(record.firstFrameMs);
  }
  return normalizeLatencySample(candidate);
}

function normalizeLatencySample(sample: WebRtcLatencySample): WebRtcLatencySample | undefined {
  if (sample.path !== "direct" && sample.path !== "relay") return undefined;
  if (sample.rttMs === undefined && sample.firstFrameMs === undefined) return undefined;
  if (sample.rttMs !== undefined && !validLatency(sample.rttMs)) return undefined;
  if (sample.firstFrameMs !== undefined && !validLatency(sample.firstFrameMs)) return undefined;
  return {
    path: sample.path,
    ...(sample.rttMs !== undefined ? { rttMs: roundMetric(sample.rttMs) } : {}),
    ...(sample.firstFrameMs !== undefined ? { firstFrameMs: roundMetric(sample.firstFrameMs) } : {})
  };
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
    firstFrame: distribution(samples.flatMap((sample) => sample.firstFrameMs === undefined ? [] : [sample.firstFrameMs]))
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
