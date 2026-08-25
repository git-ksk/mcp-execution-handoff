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

export interface WindowHandoffCoreConfig {
  takeover: TakeoverBrokerConfig;
  runtime: SpawnedWebRtcRuntimeProviderConfig;
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
    public readonly code: "UNAVAILABLE" | "TARGET_INVALID" | "INPUT_POLICY_INVALID",
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
  readonly #ttlMs: number;
  readonly #sessionIds = new Set<string>();
  readonly #sessionByIntervention = new Map<string, string>();
  readonly #expiryTimers = new Map<string, NodeJS.Timeout>();

  constructor(config: WindowHandoffCoreConfig) {
    this.#ttlMs = config.takeover.ttlMs;
    this.#runtime = new SpawnedWebRtcRuntimeProvider(config.runtime);
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
    const previous = this.#sessionByIntervention.get(interventionId);
    if (previous && previous !== sessionId) this.#forgetSession(previous);
    this.#sessionIds.add(sessionId);
    this.#sessionByIntervention.set(interventionId, sessionId);
    const existingTimer = this.#expiryTimers.get(sessionId);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => this.#forgetSession(sessionId), this.#ttlMs + 1_000);
    timer.unref();
    this.#expiryTimers.set(sessionId, timer);
  }

  #forgetIntervention(interventionId: string): void {
    const sessionId = this.#sessionByIntervention.get(interventionId);
    if (!sessionId) return;
    this.#sessionByIntervention.delete(interventionId);
    this.#forgetSession(sessionId);
  }

  #forgetSession(sessionId: string): void {
    this.#sessionIds.delete(sessionId);
    const timer = this.#expiryTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.#expiryTimers.delete(sessionId);
    for (const [interventionId, currentSessionId] of this.#sessionByIntervention) {
      if (currentSessionId === sessionId) this.#sessionByIntervention.delete(interventionId);
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
