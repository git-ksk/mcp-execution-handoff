import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
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
import {
  ManagedWindowHandoffRuntime,
  type BrowserHandoffManagedFallbackConfig
} from "./managed-handoff-runtime.js";
import { WindowHandoffCore, WindowHandoffCoreError } from "../window-takeover/window-handoff-core.js";

export type { BrowserHandoffManagedFallbackConfig } from "./managed-handoff-runtime.js";

export interface BrowserHandoffAdapterConfig {
  takeover: TakeoverBrokerConfig;
  runtime: SpawnedWebRtcRuntimeProviderConfig;
  /** Optional Handoff-owned managed fallback. Consumers do not select WSS/TURN providers. */
  managedFallback?: BrowserHandoffManagedFallbackConfig;
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
 * First-class Browser Handoff composition for standalone MCP consumers.
 *
 * Direct WebRTC remains unchanged by default. When managed fallback is configured, Handoff owns
 * the strict direct WebRTC -> WSS -> optional TURN transition while the consumer keeps one locator
 * and the same Browser lifecycle API.
 */
export class BrowserHandoffAdapter {
  readonly #core: WindowHandoffCore | ManagedWindowHandoffRuntime;

  constructor(config: BrowserHandoffAdapterConfig) {
    try {
      this.#core = config.managedFallback
        ? new ManagedWindowHandoffRuntime({
            takeover: config.takeover,
            runtime: config.runtime,
            managedFallback: config.managedFallback,
            ...(config.onComplete ? { onComplete: config.onComplete } : {})
          })
        : new WindowHandoffCore(config);
    } catch (error) {
      throw translateError(error);
    }
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
      ? this.#core.operatorDiagnosticsSnapshot("browser_handoff")
      : webRtcOperatorDiagnosticsSnapshot("browser_handoff", this.#core.diagnosticsSnapshot());
  }
  /** @internal Content-free managed WSS surface diagnostics for physical acceptance. */
  managedSurfaceDiagnosticsSnapshot(): { lastFailure: string; framesObserved: number } {
    return this.#core instanceof ManagedWindowHandoffRuntime
      ? this.#core.managedSurfaceDiagnosticsSnapshot()
      : { lastFailure: "none", framesObserved: 0 };
  }
  /** @internal Content-free managed WSS ingress diagnostics for physical acceptance. */
  managedWebSocketDiagnosticsSnapshot(): {
    disconnectKind: string; channelState: string; sentFrames: number; droppedFrames: number; lastFailure: string;
  } {
    return this.#core instanceof ManagedWindowHandoffRuntime
      ? this.#core.managedWebSocketDiagnosticsSnapshot()
      : { disconnectKind: "none", channelState: "none", sentFrames: 0, droppedFrames: 0, lastFailure: "none" };
  }
  latencySnapshot(): WebRtcLatencyComparison { return this.#core.latencySnapshot(); }
}

function translateError(error: unknown): Error {
  if (!(error instanceof WindowHandoffCoreError)) {
    return error instanceof Error
      ? new BrowserHandoffAdapterError("BROWSER_HANDOFF_UNAVAILABLE", error.message)
      : new BrowserHandoffAdapterError("BROWSER_HANDOFF_UNAVAILABLE", "Browser Handoff failed");
  }
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
  return new BrowserHandoffAdapterError("BROWSER_HANDOFF_UNAVAILABLE", error.message);
}
