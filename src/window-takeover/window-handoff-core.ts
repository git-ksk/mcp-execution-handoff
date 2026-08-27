import { spawn } from "node:child_process";
import type { WebRtcDiagnosticsSnapshot } from "../browser-takeover/webrtc-diagnostics.js";
import type { WebRtcLatencyComparison } from "../browser-takeover/webrtc-latency.js";
import {
  TakeoverBroker,
  type TakeoverBrokerConfig,
  type TakeoverBrowserAdapter,
  type TakeoverCompletionEvent,
  type TakeoverHostTarget,
  type TakeoverInterventionRef
} from "../browser-takeover/broker.js";
import {
  SpawnedWebRtcRuntimeProvider,
  type SpawnedWebRtcRuntimeProviderConfig,
  type WebRtcHumanInputPolicy
} from "../browser-takeover/webrtc-runtime-diagnostics.js";

export interface WindowHandoffCoreSuccessorPolicy {
  mode: "same_process";
  transitionWindowMs?: number;
}

export interface WindowHandoffCoreConfig {
  takeover: TakeoverBrokerConfig;
  runtime: SpawnedWebRtcRuntimeProviderConfig;
  successorWindowPolicy?: WindowHandoffCoreSuccessorPolicy;
  onComplete?: (event: TakeoverCompletionEvent) => void | Promise<void>;
}

export interface WindowHandoffCoreStartRequest {
  intervention: TakeoverInterventionRef;
  principalBinding: string;
  target: TakeoverHostTarget;
  inputPolicy: WebRtcHumanInputPolicy;
}

export class WindowHandoffCoreError extends Error {
  constructor(
    public readonly code: "UNAVAILABLE" | "TARGET_INVALID" | "INPUT_POLICY_INVALID" | "SUCCESSOR_POLICY_INVALID",
    message: string
  ) {
    super(message);
    this.name = "WindowHandoffCoreError";
  }
}

/** Shared bounded-window WebRTC/session composition used by Browser and Window facades. */
export class WindowHandoffCore {
  readonly #runtime: SpawnedWebRtcRuntimeProvider;
  readonly #broker: TakeoverBroker;
  readonly #routeTtlMs: number;
  readonly #sessionIds = new Set<string>();
  readonly #sessionsByIntervention = new Map<string, Set<string>>();
  readonly #expiryTimers = new Map<string, NodeJS.Timeout>();

  constructor(config: WindowHandoffCoreConfig) {
    const successorPolicy = normalizeSuccessorPolicy(config.successorWindowPolicy);
    if (config.successorWindowPolicy && !successorPolicy) {
      throw new WindowHandoffCoreError(
        "SUCCESSOR_POLICY_INVALID",
        "Window successor policy must use same_process with a transition window between 100 and 2000 ms"
      );
    }
    const completionGraceMs = config.takeover.completionGraceMs ?? config.takeover.ttlMs;
    this.#routeTtlMs = config.takeover.ttlMs + completionGraceMs;
    this.#runtime = new SpawnedWebRtcRuntimeProvider(runtimeConfigWithSuccessorPolicy(config.runtime, successorPolicy));
    this.#broker = new TakeoverBroker(
      webRtcOnlySurfaceAdapter(),
      config.takeover,
      undefined,
      this.#runtime,
      config.onComplete ? { completed: config.onComplete } : {}
    );
  }

  isEnabled(): boolean {
    return this.#broker.isEnabled();
  }

  isPath(pathname: string): boolean {
    return this.#broker.isPath(pathname);
  }

  ownsPath(pathname: string): boolean {
    if (!this.isEnabled()) return false;
    if (pathname === "/takeover/webrtc-client.js") return true;
    const sessionId = takeoverSessionIdFromPath(pathname);
    return sessionId !== undefined && this.#sessionIds.has(sessionId);
  }

  start(request: WindowHandoffCoreStartRequest): string {
    if (!validTarget(request.target)) {
      throw new WindowHandoffCoreError(
        "TARGET_INVALID",
        "bounded Window Handoff requires a positive process id and an optional positive window id"
      );
    }
    if (!validInputPolicy(request.inputPolicy)) {
      throw new WindowHandoffCoreError(
        "INPUT_POLICY_INVALID",
        "bounded Window Handoff requires an explicit Human input policy"
      );
    }
    const locator = this.#broker.createWebRtcLink(
      request.intervention,
      request.principalBinding,
      request.target,
      request.inputPolicy
    );
    if (!locator) throw new WindowHandoffCoreError("UNAVAILABLE", "bounded Window WebRTC Handoff is unavailable");
    const sessionId = takeoverSessionIdFromPath(new URL(locator).pathname);
    if (!sessionId) throw new WindowHandoffCoreError("UNAVAILABLE", "bounded Window Handoff locator is invalid");
    this.#rememberSession(request.intervention.id, sessionId);
    return locator;
  }

  async revoke(interventionId: string): Promise<void> {
    this.#forgetIntervention(interventionId);
    await this.#broker.revokeWebRtcForIntervention(interventionId);
  }

  /**
   * Synchronously revoke an unclaimed locator/control-plane session.
   * Runtime cleanup remains best-effort inside TakeoverBroker; no Human generation has been claimed.
   */
  revokeUnclaimed(interventionId: string): void {
    this.#forgetIntervention(interventionId);
    this.#broker.revokeForIntervention(interventionId);
  }

  handle(request: Request, boundPrincipal: string | undefined): Promise<Response> {
    return this.#broker.handle(request, boundPrincipal);
  }

  diagnosticsSnapshot(): WebRtcDiagnosticsSnapshot {
    return this.#runtime.diagnosticsSnapshot();
  }

  latencySnapshot(): WebRtcLatencyComparison {
    return this.#runtime.latencySnapshot();
  }

  #rememberSession(interventionId: string, sessionId: string): void {
    this.#sessionIds.add(sessionId);
    const sessions = this.#sessionsByIntervention.get(interventionId) ?? new Set<string>();
    sessions.add(sessionId);
    this.#sessionsByIntervention.set(interventionId, sessions);
    const existingTimer = this.#expiryTimers.get(sessionId);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => this.#forgetSession(sessionId), this.#routeTtlMs + 1_000);
    timer.unref();
    this.#expiryTimers.set(sessionId, timer);
  }

  #forgetIntervention(interventionId: string): void {
    const sessions = this.#sessionsByIntervention.get(interventionId);
    if (!sessions) return;
    this.#sessionsByIntervention.delete(interventionId);
    for (const sessionId of [...sessions]) this.#forgetSession(sessionId);
  }

  #forgetSession(sessionId: string): void {
    this.#sessionIds.delete(sessionId);
    const timer = this.#expiryTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.#expiryTimers.delete(sessionId);
    for (const [interventionId, sessions] of this.#sessionsByIntervention) {
      sessions.delete(sessionId);
      if (sessions.size === 0) this.#sessionsByIntervention.delete(interventionId);
    }
  }
}

export function validWindowHandoffTarget(target: TakeoverHostTarget): boolean {
  return Number.isSafeInteger(target.processId) && target.processId > 0 &&
    (target.windowId === undefined || (Number.isSafeInteger(target.windowId) && target.windowId > 0));
}

export function validWindowHandoffInputPolicy(policy: WebRtcHumanInputPolicy): boolean {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return false;
  const record = policy as unknown as Record<string, unknown>;
  const keys = ["tap", "scroll", "text", "key"] as const;
  return Object.keys(record).length === keys.length
    && Object.keys(record).every((key) => keys.includes(key as typeof keys[number]))
    && keys.every((key) => typeof record[key] === "boolean");
}

function validTarget(target: TakeoverHostTarget): boolean {
  return validWindowHandoffTarget(target);
}

function validInputPolicy(policy: WebRtcHumanInputPolicy): boolean {
  return validWindowHandoffInputPolicy(policy);
}

function takeoverSessionIdFromPath(pathname: string): string | undefined {
  const page = /^\/takeover\/([A-Za-z0-9-]{8,100})$/.exec(pathname);
  if (page) return page[1];
  const api = /^\/takeover\/api\/[a-z0-9-]+\/([A-Za-z0-9-]{8,100})$/.exec(pathname);
  return api?.[1];
}

function webRtcOnlySurfaceAdapter(): TakeoverBrowserAdapter {
  const unavailable = async (): Promise<never> => {
    throw new WindowHandoffCoreError("UNAVAILABLE", "HTTP frame/input takeover is unavailable through bounded Window Handoff");
  };
  return {
    captureHumanTakeoverFrame: unavailable,
    tapHumanTakeover: unavailable,
    scrollHumanTakeover: unavailable,
    insertHumanTakeoverText: unavailable,
    pressHumanTakeoverKey: unavailable
  };
}


interface NormalizedSuccessorPolicy {
  mode: "same_process";
  transitionWindowMs: number;
}

function normalizeSuccessorPolicy(policy: WindowHandoffCoreSuccessorPolicy | undefined): NormalizedSuccessorPolicy | undefined {
  if (!policy) return undefined;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return undefined;
  const record = policy as unknown as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "mode" && key !== "transitionWindowMs")) return undefined;
  if (record.mode !== "same_process") return undefined;
  const transitionWindowMs = record.transitionWindowMs === undefined ? 800 : Number(record.transitionWindowMs);
  if (!Number.isSafeInteger(transitionWindowMs) || transitionWindowMs < 100 || transitionWindowMs > 2_000) return undefined;
  return { mode: "same_process", transitionWindowMs };
}

function runtimeConfigWithSuccessorPolicy(
  runtime: SpawnedWebRtcRuntimeProviderConfig,
  policy: NormalizedSuccessorPolicy | undefined
): SpawnedWebRtcRuntimeProviderConfig {
  if (!policy) return runtime;
  const baseSpawn = runtime.spawnProcess ?? spawn;
  const spawnProcess = ((command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
    const env = {
      ...(options?.env ?? {}),
      TAKEOVER_WEBRTC_WINDOW_LINEAGE: "same_process_successor",
      TAKEOVER_WEBRTC_WINDOW_LINEAGE_TRANSITION_MS: String(policy.transitionWindowMs)
    };
    return baseSpawn(command, args as string[], { ...options, env });
  }) as typeof spawn;
  return { ...runtime, spawnProcess };
}
