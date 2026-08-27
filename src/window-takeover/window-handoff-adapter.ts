import type { OperatorDiagnosticsSnapshot } from "../core/operator-diagnostics.js";
import { webRtcOperatorDiagnosticsSnapshot, type WebRtcDiagnosticsSnapshot } from "../browser-takeover/webrtc-diagnostics.js";
import type { WebRtcLatencyComparison } from "../browser-takeover/webrtc-latency.js";
import type { TakeoverCompletionEvent, TakeoverHostTarget, TakeoverInterventionRef } from "../browser-takeover/broker.js";
import type { SpawnedWebRtcRuntimeProviderConfig, WebRtcHumanInputPolicy } from "../browser-takeover/webrtc-runtime-diagnostics.js";
import type { TakeoverBrokerConfig } from "../browser-takeover/broker.js";
import { WindowHandoffCore, WindowHandoffCoreError } from "./window-handoff-core.js";

export interface WindowHandoffSuccessorPolicy {
  /** Admit only one newly observed successor owned by the exact same process. */
  mode: "same_process";
  /** Bounded post-Human-action probe window. Defaults to 800 ms. */
  transitionWindowMs?: number;
}

export interface WindowHandoffInitialSecureWindowPolicy {
  /** Admit only Apple's exact LocalAuthentication user-presence dialog as the initial target. */
  mode: "macos_local_authentication";
}

export interface WindowHandoffAdapterConfig {
  takeover: TakeoverBrokerConfig;
  runtime: SpawnedWebRtcRuntimeProviderConfig;
  /** Optional Human-only successor-window lineage. Exact-one-window behavior remains the default. */
  successorWindowPolicy?: WindowHandoffSuccessorPolicy;
  /** Optional, default-off admission for Apple's exact LocalAuthentication user-presence dialog. */
  initialSecureWindowPolicy?: WindowHandoffInitialSecureWindowPolicy;
  /** Called only after Human transport authority is fenced. Consumer performs fresh verification. */
  onComplete?: (event: TakeoverCompletionEvent) => void | Promise<void>;
}

export type WindowHandoffInputPolicy = WebRtcHumanInputPolicy;

export interface WindowHandoffStartRequest {
  intervention: TakeoverInterventionRef;
  principalBinding: string;
  target: TakeoverHostTarget;
  inputPolicy: WindowHandoffInputPolicy;
}

export class WindowHandoffAdapterError extends Error {
  constructor(
    public readonly code:
      | "WINDOW_HANDOFF_UNAVAILABLE"
      | "WINDOW_HANDOFF_TARGET_INVALID"
      | "WINDOW_HANDOFF_INPUT_POLICY_INVALID"
      | "WINDOW_HANDOFF_SUCCESSOR_POLICY_INVALID"
      | "WINDOW_HANDOFF_INITIAL_SECURE_WINDOW_POLICY_INVALID",
    message: string
  ) {
    super(message);
    this.name = "WindowHandoffAdapterError";
  }
}

/**
 * First-class bounded OS-window WebRTC Handoff composition for MCP consumers.
 *
 * Consumers own application/domain semantics, process lifecycle, intervention policy and fresh
 * verification. Handoff owns locator/session lifecycle, exact process/window capture/input,
 * WebRTC/TURN/reconnect behavior, revoke and privacy-bounded transport diagnostics.
 *
 * This adapter always requires an exact process boundary and never exposes display/desktop-wide
 * capture as a fallback.
 */
export class WindowHandoffAdapter {
  readonly #core: WindowHandoffCore;

  constructor(config: WindowHandoffAdapterConfig) {
    try {
      this.#core = new WindowHandoffCore({ ...config, mediaProfile: "window_text" });
    } catch (error) {
      throw translateError(error);
    }
  }

  isEnabled(): boolean { return this.#core.isEnabled(); }
  isPath(pathname: string): boolean { return this.#core.isPath(pathname); }
  ownsPath(pathname: string): boolean { return this.#core.ownsPath(pathname); }

  start(request: WindowHandoffStartRequest): string {
    try {
      return this.#core.start(request);
    } catch (error) {
      throw translateError(error);
    }
  }

  async revoke(interventionId: string): Promise<void> { await this.#core.revoke(interventionId); }
  async revokeForIntervention(interventionId: string): Promise<void> { await this.revoke(interventionId); }
  /** Fence a session only after the consumer independently verifies the Human action succeeded. */
  async completeAfterVerification(intervention: TakeoverInterventionRef): Promise<boolean> {
    return this.#core.completeAfterVerification(intervention);
  }
  /** Synchronously invalidate a locator that was cancelled before any Human generation was claimed. */
  revokeUnclaimed(interventionId: string): void { this.#core.revokeUnclaimed(interventionId); }
  handle(request: Request, boundPrincipal: string | undefined): Promise<Response> { return this.#core.handle(request, boundPrincipal); }
  diagnosticsSnapshot(): WebRtcDiagnosticsSnapshot { return this.#core.diagnosticsSnapshot(); }
  operatorDiagnosticsSnapshot(): OperatorDiagnosticsSnapshot { return webRtcOperatorDiagnosticsSnapshot("window_handoff", this.#core.diagnosticsSnapshot()); }
  latencySnapshot(): WebRtcLatencyComparison { return this.#core.latencySnapshot(); }
}

function translateError(error: unknown): Error {
  if (!(error instanceof WindowHandoffCoreError)) return error instanceof Error ? error : new Error("Window Handoff failed");
  const code = error.code === "TARGET_INVALID"
    ? "WINDOW_HANDOFF_TARGET_INVALID"
    : error.code === "INPUT_POLICY_INVALID"
      ? "WINDOW_HANDOFF_INPUT_POLICY_INVALID"
      : error.code === "SUCCESSOR_POLICY_INVALID"
        ? "WINDOW_HANDOFF_SUCCESSOR_POLICY_INVALID"
        : error.code === "INITIAL_SECURE_WINDOW_POLICY_INVALID"
          ? "WINDOW_HANDOFF_INITIAL_SECURE_WINDOW_POLICY_INVALID"
          : "WINDOW_HANDOFF_UNAVAILABLE";
  return new WindowHandoffAdapterError(code, error.message);
}
