import type { OperatorDiagnosticsSnapshot } from "../core/operator-diagnostics.js";
import { webRtcOperatorDiagnosticsSnapshot, type WebRtcDiagnosticsSnapshot } from "./webrtc-diagnostics.js";
import type { WebRtcLatencyComparison } from "./webrtc-latency.js";
import type {
  TakeoverBrokerConfig,
  TakeoverCompletionEvent,
  TakeoverHostTarget,
  TakeoverInterventionRef
} from "./broker.js";
import type {
  SpawnedWebRtcRuntimeProviderConfig,
  WebRtcHumanInputPolicy
} from "./webrtc-runtime-diagnostics.js";
import { WindowHandoffCore, WindowHandoffCoreError } from "../window-takeover/window-handoff-core.js";

export interface BrowserHandoffAdapterConfig {
  takeover: TakeoverBrokerConfig;
  runtime: SpawnedWebRtcRuntimeProviderConfig;
  /** Called only after Human transport authority is fenced. Consumer performs fresh verification. */
  onComplete?: (event: TakeoverCompletionEvent) => void | Promise<void>;
}

export type BrowserHandoffInputPolicy = WebRtcHumanInputPolicy;

export interface BrowserHandoffStartRequest {
  intervention: TakeoverInterventionRef;
  principalBinding: string;
  target: TakeoverHostTarget;
  inputPolicy: BrowserHandoffInputPolicy;
}

export class BrowserHandoffAdapterError extends Error {
  constructor(
    public readonly code:
      | "BROWSER_HANDOFF_UNAVAILABLE"
      | "BROWSER_HANDOFF_TARGET_INVALID"
      | "BROWSER_HANDOFF_INPUT_POLICY_INVALID",
    message: string
  ) {
    super(message);
    this.name = "BrowserHandoffAdapterError";
  }
}

/**
 * First-class Browser WebRTC Handoff composition for standalone MCP consumers.
 *
 * Browser/profile/authentication semantics remain consumer-owned. This facade reuses the same
 * bounded exact-window WebRTC/session core as `WindowHandoffAdapter`, while preserving the existing
 * Browser public API and its explicit no-HTTP-frame-downgrade contract.
 */
export class BrowserHandoffAdapter {
  readonly #core: WindowHandoffCore;

  constructor(config: BrowserHandoffAdapterConfig) {
    this.#core = new WindowHandoffCore(config);
  }

  isEnabled(): boolean { return this.#core.isEnabled(); }
  isPath(pathname: string): boolean { return this.#core.isPath(pathname); }
  ownsPath(pathname: string): boolean { return this.#core.ownsPath(pathname); }

  start(request: BrowserHandoffStartRequest): string {
    try {
      return this.#core.start(request);
    } catch (error) {
      throw translateError(error);
    }
  }

  async revoke(interventionId: string): Promise<void> { await this.#core.revoke(interventionId); }
  async revokeForIntervention(interventionId: string): Promise<void> { await this.revoke(interventionId); }
  handle(request: Request, boundPrincipal: string | undefined): Promise<Response> { return this.#core.handle(request, boundPrincipal); }
  diagnosticsSnapshot(): WebRtcDiagnosticsSnapshot { return this.#core.diagnosticsSnapshot(); }
  operatorDiagnosticsSnapshot(): OperatorDiagnosticsSnapshot { return webRtcOperatorDiagnosticsSnapshot("browser_handoff", this.#core.diagnosticsSnapshot()); }
  latencySnapshot(): WebRtcLatencyComparison { return this.#core.latencySnapshot(); }
}

function translateError(error: unknown): Error {
  if (!(error instanceof WindowHandoffCoreError)) return error instanceof Error ? error : new Error("Browser Handoff failed");
  if (error.code === "TARGET_INVALID") {
    return new BrowserHandoffAdapterError(
      "BROWSER_HANDOFF_TARGET_INVALID",
      "Browser Handoff requires a positive process id and an optional positive window id"
    );
  }
  if (error.code === "INPUT_POLICY_INVALID") {
    return new BrowserHandoffAdapterError(
      "BROWSER_HANDOFF_INPUT_POLICY_INVALID",
      "Browser Handoff requires an explicit bounded Human input policy"
    );
  }
  return new BrowserHandoffAdapterError("BROWSER_HANDOFF_UNAVAILABLE", "Browser WebRTC Handoff is unavailable");
}
