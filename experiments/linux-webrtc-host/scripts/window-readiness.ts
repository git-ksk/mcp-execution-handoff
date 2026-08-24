export interface LinuxWindowReadinessSample {
  processAlive: boolean;
  candidateIds: readonly string[];
  candidateTitle?: string;
  pageInteractive: boolean;
}

export interface LinuxWindowReadinessDiagnostics {
  candidateCount: number;
  titleMatched: boolean;
  pageInteractive: boolean;
  processAlive: boolean;
  elapsedMs: number;
}

export class LinuxWindowReadinessError extends Error {
  constructor(
    public readonly code: "PROCESS_EXITED" | "READINESS_TIMEOUT",
    public readonly diagnostics: LinuxWindowReadinessDiagnostics,
    message: string
  ) {
    super(message);
    this.name = "LinuxWindowReadinessError";
  }
}

export interface WaitForLinuxWindowReadinessOptions {
  observe(): Promise<LinuxWindowReadinessSample> | LinuxWindowReadinessSample;
  expectedTitle: string;
  timeoutMs?: number;
  pollMs?: number;
  stableSamples?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Establish one exact Linux/X11 target from coherent bounded observations.
 *
 * The accepted id is never obtained from a second uncorrelated search after readiness succeeds.
 * A transient 1 -> 0 or 1 -> multiple transition resets stability; ambiguity never causes an
 * arbitrary candidate to be selected. The same exact id must remain eligible/title-matched/page-
 * ready for the configured number of consecutive samples before it is returned to the caller.
 */
export async function waitForLinuxWindowReadiness(
  options: WaitForLinuxWindowReadinessOptions
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 50;
  const stableSamples = options.stableSamples ?? 2;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 ||
      !Number.isInteger(pollMs) || pollMs < 0 ||
      !Number.isInteger(stableSamples) || stableSamples < 1 || stableSamples > 10 ||
      !options.expectedTitle.trim()) {
    throw new Error("Linux window readiness options are invalid");
  }

  const startedAt = now();
  let stableId: string | undefined;
  let stableCount = 0;
  let last: LinuxWindowReadinessDiagnostics = {
    candidateCount: 0,
    titleMatched: false,
    pageInteractive: false,
    processAlive: true,
    elapsedMs: 0
  };

  while (now() - startedAt < timeoutMs) {
    const sample = await options.observe();
    const candidateCount = boundedCandidateCount(sample.candidateIds.length);
    const oneCandidate = sample.candidateIds.length === 1 ? sample.candidateIds[0] : undefined;
    const titleMatched = Boolean(oneCandidate && sample.candidateTitle?.includes(options.expectedTitle));
    last = {
      candidateCount,
      titleMatched,
      pageInteractive: sample.pageInteractive,
      processAlive: sample.processAlive,
      elapsedMs: boundedElapsed(now() - startedAt)
    };

    if (!sample.processAlive) {
      throw new LinuxWindowReadinessError(
        "PROCESS_EXITED",
        last,
        `normal Chrome exited before bounded window readiness (${formatDiagnostics(last)})`
      );
    }

    if (oneCandidate && titleMatched && sample.pageInteractive) {
      if (stableId === oneCandidate) stableCount += 1;
      else {
        stableId = oneCandidate;
        stableCount = 1;
      }
      if (stableCount >= stableSamples) return oneCandidate;
    } else {
      stableId = undefined;
      stableCount = 0;
    }

    await sleep(pollMs);
  }

  last.elapsedMs = boundedElapsed(now() - startedAt);
  throw new LinuxWindowReadinessError(
    "READINESS_TIMEOUT",
    last,
    `Linux WebRTC acceptance timed out at chrome-window readiness (${formatDiagnostics(last)})`
  );
}

function boundedCandidateCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) return 0;
  return Math.min(value, 9);
}

function boundedElapsed(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(120_000, Math.round(value));
}

function formatDiagnostics(value: LinuxWindowReadinessDiagnostics): string {
  return [
    `candidates=${value.candidateCount}`,
    `title=${value.titleMatched ? "match" : "no-match"}`,
    `page_ready=${value.pageInteractive ? "yes" : "no"}`,
    `process_alive=${value.processAlive ? "yes" : "no"}`,
    `elapsed_ms=${value.elapsedMs}`
  ].join(" ");
}
