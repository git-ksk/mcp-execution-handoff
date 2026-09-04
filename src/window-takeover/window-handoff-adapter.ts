import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { OperatorDiagnosticsSnapshot } from "../core/operator-diagnostics.js";
import {
  createPhysicalDesktopSessionBoundary,
  type DesktopSessionDisplayBoundary
} from "../desktop-session/desktop-session.js";
import {
  emptyManagedOperatorDiagnosticsSnapshot,
  type ManagedOperatorDiagnosticEventObserver,
  type ManagedOperatorDiagnosticsSnapshot
} from "../browser-takeover/managed-operator-diagnostics.js";
import { webRtcOperatorDiagnosticsSnapshot, type WebRtcDiagnosticsSnapshot } from "../browser-takeover/webrtc-diagnostics.js";
import type { WebRtcLatencyComparison } from "../browser-takeover/webrtc-latency.js";
import type { TakeoverCompletionEvent, TakeoverHostTarget, TakeoverInterventionRef } from "../browser-takeover/broker.js";
import type { SpawnedWebRtcRuntimeProviderConfig, WebRtcHumanInputPolicy } from "../browser-takeover/webrtc-runtime-diagnostics.js";
import type { TakeoverBrokerConfig } from "../browser-takeover/broker.js";
import type { ManagedHandoffTransportPolicy } from "../browser-takeover/transport-fallback-policy.js";
import {
  ManagedWindowHandoffRuntime,
  type BrowserHandoffManagedFallbackConfig
} from "../browser-takeover/managed-handoff-runtime.js";
import { WindowHandoffCore, WindowHandoffCoreError } from "./window-handoff-core.js";

export type { ManagedHandoffTransportPolicy } from "../browser-takeover/transport-fallback-policy.js";
export type { BrowserHandoffManagedFallbackConfig } from "../browser-takeover/managed-handoff-runtime.js";

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
  /** Optional Handoff-owned managed WSS host configuration. Provider secrets remain deployment-owned. */
  managedFallback?: BrowserHandoffManagedFallbackConfig;
  /** Optional exact transport order. One item is an explicit transport-only mode. */
  transportPolicy?: ManagedHandoffTransportPolicy;
  /** Observe-only bounded managed diagnostic events; callback failures cannot alter authority. */
  onManagedOperatorDiagnosticEvent?: ManagedOperatorDiagnosticEventObserver;
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
 * First-class bounded OS-window Handoff composition for MCP consumers.
 *
 * Direct WebRTC remains the default. An explicit transport policy may select one attempt or any
 * reviewed order of direct WebRTC, WSS, and relay-capable WebRTC. Handoff fences each abandoned
 * generation before transition and still never widens Window authority to display capture.
 */
export class WindowHandoffAdapter {
  readonly #core: WindowHandoffCore | ManagedWindowHandoffRuntime;
  readonly #directDesktopSessions = new Map<string, DesktopSessionDisplayBoundary>();

  constructor(config: WindowHandoffAdapterConfig) {
    try {
      this.#core = config.managedFallback || config.transportPolicy
        ? new ManagedWindowHandoffRuntime({
            takeover: config.takeover,
            runtime: config.runtime,
            ...(config.managedFallback ? { managedFallback: config.managedFallback } : {}),
            ...(config.transportPolicy ? { transportPolicy: config.transportPolicy } : {}),
            ...(config.onManagedOperatorDiagnosticEvent
              ? { onManagedOperatorDiagnosticEvent: config.onManagedOperatorDiagnosticEvent }
              : {}),
            mediaProfile: "window_text",
            ...(config.successorWindowPolicy ? { successorWindowPolicy: config.successorWindowPolicy } : {}),
            ...(config.initialSecureWindowPolicy ? { initialSecureWindowPolicy: config.initialSecureWindowPolicy } : {}),
            desktopSessionBoundary: "physical_window",
            ...(config.onComplete ? { onComplete: config.onComplete } : {})
          })
        : new WindowHandoffCore({
            ...config,
            mediaProfile: "window_text",
            onAuthorityReleased: (event) => {
              this.#directDesktopSessions.get(event.interventionId)?.detachCurrentViewer();
            }
          });
    } catch (error) {
      throw translateError(error);
    }
  }

  isEnabled(): boolean { return this.#core.isEnabled(); }
  isPath(pathname: string): boolean { return this.#core.isPath(pathname); }
  ownsPath(pathname: string): boolean { return this.#core.ownsPath(pathname); }

  start(request: WindowHandoffStartRequest): string {
    try {
      const locator = this.#core.start(request);
      if (this.#core instanceof WindowHandoffCore) {
        const desktopSession = createPhysicalDesktopSessionBoundary({
          kind: "bounded_window",
          processId: request.target.processId,
          ...(request.target.windowId === undefined ? {} : { windowId: request.target.windowId })
        });
        desktopSession.attachViewer(1);
        this.#directDesktopSessions.set(request.intervention.id, desktopSession);
      }
      return locator;
    } catch (error) {
      throw translateError(error);
    }
  }

  async revoke(interventionId: string): Promise<void> {
    try {
      await this.#core.revoke(interventionId);
    } finally {
      const desktopSession = this.#directDesktopSessions.get(interventionId);
      desktopSession?.close();
      this.#directDesktopSessions.delete(interventionId);
    }
  }
  async revokeForIntervention(interventionId: string): Promise<void> { await this.revoke(interventionId); }
  /** Fence a session only after the consumer independently verifies the Human action succeeded. */
  async completeAfterVerification(intervention: TakeoverInterventionRef): Promise<boolean> {
    const completed = await this.#core.completeAfterVerification(intervention);
    if (completed) {
      const desktopSession = this.#directDesktopSessions.get(intervention.id);
      desktopSession?.close();
      this.#directDesktopSessions.delete(intervention.id);
    }
    return completed;
  }
  /** Synchronously invalidate a locator that was cancelled before any Human generation was claimed. */
  revokeUnclaimed(interventionId: string): void {
    try {
      this.#core.revokeUnclaimed(interventionId);
    } finally {
      const desktopSession = this.#directDesktopSessions.get(interventionId);
      desktopSession?.close();
      this.#directDesktopSessions.delete(interventionId);
    }
  }
  handle(request: Request, boundPrincipal: string | undefined): Promise<Response> {
    return this.#core.handle(request, boundPrincipal);
  }
  /** Route Node HTTP upgrades only when managed WSS is the active Handoff transport. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    return this.#core instanceof ManagedWindowHandoffRuntime
      ? this.#core.handleUpgrade(request, socket, head)
      : false;
  }
  diagnosticsSnapshot(): WebRtcDiagnosticsSnapshot { return this.#core.diagnosticsSnapshot(); }
  operatorDiagnosticsSnapshot(): OperatorDiagnosticsSnapshot {
    return this.#core instanceof ManagedWindowHandoffRuntime
      ? this.#core.operatorDiagnosticsSnapshot("window_handoff")
      : webRtcOperatorDiagnosticsSnapshot("window_handoff", this.#core.diagnosticsSnapshot());
  }
  /** Stable content-free managed transport diagnostics; empty when managed fallback is disabled. */
  managedOperatorDiagnosticsSnapshot(): ManagedOperatorDiagnosticsSnapshot {
    return this.#core instanceof ManagedWindowHandoffRuntime
      ? this.#core.managedOperatorDiagnosticsSnapshot("window_handoff")
      : emptyManagedOperatorDiagnosticsSnapshot("window_handoff");
  }
  latencySnapshot(): WebRtcLatencyComparison { return this.#core.latencySnapshot(); }
}

function translateError(error: unknown): Error {
  if (!(error instanceof WindowHandoffCoreError)) {
    return error instanceof Error
      ? new WindowHandoffAdapterError("WINDOW_HANDOFF_UNAVAILABLE", error.message)
      : new WindowHandoffAdapterError("WINDOW_HANDOFF_UNAVAILABLE", "Window Handoff failed");
  }
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
