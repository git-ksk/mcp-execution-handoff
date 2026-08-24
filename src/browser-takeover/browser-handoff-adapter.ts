import type { WebRtcDiagnosticsSnapshot } from "./webrtc-diagnostics.js";
import type { WebRtcLatencyComparison } from "./webrtc-latency.js";
import {
  TakeoverBroker,
  type TakeoverBrokerConfig,
  type TakeoverBrowserAdapter,
  type TakeoverHostTarget,
  type TakeoverInterventionRef
} from "./broker.js";
import {
  SpawnedWebRtcRuntimeProvider,
  type SpawnedWebRtcRuntimeProviderConfig
} from "./webrtc-runtime-diagnostics.js";

export interface BrowserHandoffAdapterConfig {
  takeover: TakeoverBrokerConfig;
  runtime: SpawnedWebRtcRuntimeProviderConfig;
}

export interface BrowserHandoffStartRequest {
  intervention: TakeoverInterventionRef;
  principalBinding: string;
  target: TakeoverHostTarget;
}

export class BrowserHandoffAdapterError extends Error {
  constructor(
    public readonly code:
      | "BROWSER_HANDOFF_UNAVAILABLE"
      | "BROWSER_HANDOFF_TARGET_INVALID",
    message: string
  ) {
    super(message);
    this.name = "BrowserHandoffAdapterError";
  }
}

/**
 * First-class Browser WebRTC Handoff composition for standalone MCP consumers.
 *
 * Consumers own why Human intervention is required, browser/profile lifecycle, semantic/input
 * policy, and fresh post-Human verification. Handoff owns the short-lived Browser Handoff
 * locator, WebRTC runtime, direct/relay transport behavior, exact target binding, reconnect
 * generation fencing, revoke, and bounded transport diagnostics.
 *
 * This adapter deliberately has no generic HTTP-frame start method. A missing/unavailable WebRTC
 * runtime therefore cannot silently downgrade a canonical Browser Handoff into screenshot polling.
 */
export class BrowserHandoffAdapter {
  readonly #runtime: SpawnedWebRtcRuntimeProvider;
  readonly #broker: TakeoverBroker;

  constructor(config: BrowserHandoffAdapterConfig) {
    this.#runtime = new SpawnedWebRtcRuntimeProvider(config.runtime);
    this.#broker = new TakeoverBroker(
      webRtcOnlyBrowserAdapter(),
      config.takeover,
      undefined,
      this.#runtime
    );
  }

  isEnabled(): boolean {
    return this.#broker.isEnabled();
  }

  isPath(pathname: string): boolean {
    return this.#broker.isPath(pathname);
  }

  /**
   * Issue one short-lived locator for an exact browser target.
   *
   * Locator issuance only means the control-plane session exists. Runtime/media readiness is
   * established later by the existing WebRTC prepare/connect path, which preserves the host-window
   * and first-media-frame readiness gates before an answer is returned.
   */
  start(request: BrowserHandoffStartRequest): string {
    if (!validTarget(request.target)) {
      throw new BrowserHandoffAdapterError(
        "BROWSER_HANDOFF_TARGET_INVALID",
        "Browser Handoff requires a positive process id and an optional positive window id"
      );
    }
    const locator = this.#broker.createWebRtcLink(
      request.intervention,
      request.principalBinding,
      request.target
    );
    if (!locator) {
      throw new BrowserHandoffAdapterError(
        "BROWSER_HANDOFF_UNAVAILABLE",
        "Browser WebRTC Handoff is unavailable"
      );
    }
    return locator;
  }

  async revoke(interventionId: string): Promise<void> {
    await this.#broker.revokeWebRtcForIntervention(interventionId);
  }

  /** Alias for consumers that already use broker-style lifecycle naming. */
  async revokeForIntervention(interventionId: string): Promise<void> {
    await this.revoke(interventionId);
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
}

function validTarget(target: TakeoverHostTarget): boolean {
  return Number.isSafeInteger(target.processId) && target.processId > 0 &&
    (target.windowId === undefined || (Number.isSafeInteger(target.windowId) && target.windowId > 0));
}

function webRtcOnlyBrowserAdapter(): TakeoverBrowserAdapter {
  const unavailable = async (): Promise<never> => {
    throw new BrowserHandoffAdapterError(
      "BROWSER_HANDOFF_UNAVAILABLE",
      "HTTP frame/input takeover is not available through BrowserHandoffAdapter"
    );
  };
  return {
    captureHumanTakeoverFrame: unavailable,
    tapHumanTakeover: unavailable,
    scrollHumanTakeover: unavailable,
    insertHumanTakeoverText: unavailable,
    pressHumanTakeoverKey: unavailable
  };
}
