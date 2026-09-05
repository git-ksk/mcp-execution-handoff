import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type {
  TakeoverCompletionEvent,
  TakeoverHostTarget,
  TakeoverInterventionRef
} from "../browser-takeover/broker.js";
import type { TakeoverBrokerConfig } from "../browser-takeover/broker.js";
import {
  ExperimentalWebSocketBrowserHandoff as WebSocketBrowserHandoff
} from "../browser-takeover/websocket-browser-handoff.js";
import {
  ExperimentalLinuxWebSocketWindowSurface as LinuxWebSocketWindowSurface
} from "../browser-takeover/linux-websocket-window-surface.js";
import {
  MacOSWebSocketWindowSurface,
  type MacOSWebSocketWindowSurfaceConfig
} from "../browser-takeover/macos-websocket-window-surface.js";
import type { ManagedOperatorDiagnosticEventKind } from "../browser-takeover/managed-operator-diagnostics.js";
import type { WebSocketTakeoverInputPolicy } from "../browser-takeover/websocket-takeover.js";
import type { ExperimentalWebSocketWindowSurface } from "../browser-takeover/websocket-window-handoff.js";
import { WebSocketLatencyTracker, type WebSocketLatencySnapshot } from "../browser-takeover/websocket-latency.js";

export interface MacOSWindowWebSocketHostConfig
  extends Omit<MacOSWebSocketWindowSurfaceConfig, "onDiagnosticEvent" | "successorWindowPolicy" | "latencyTracker"> {
  platform: "macos";
}

export interface LinuxWindowWebSocketHostConfig {
  platform: "linux";
  hostScript: string;
  displayName: string;
  xdotoolExecutable?: string;
  authorityHelperExecutable?: string;
  helperTtlMs?: number;
}

export type WindowWebSocketHostConfig =
  | MacOSWindowWebSocketHostConfig
  | LinuxWindowWebSocketHostConfig;

export interface WindowWebSocketHandoffAdapterConfig {
  takeover: TakeoverBrokerConfig;
  allowedOrigins: readonly string[];
  host: WindowWebSocketHostConfig;
  frameIntervalMs?: number;
  maxInboundBytes?: number;
  successorWindowPolicy?: { mode: "same_process"; transitionWindowMs?: number };
  onOperatorDiagnosticEvent?: (kind: ManagedOperatorDiagnosticEventKind) => void;
  /** Human Done only: the consumer must perform fresh semantic verification afterwards. */
  onComplete?: (event: TakeoverCompletionEvent) => void | Promise<void>;
}

export interface WindowWebSocketHandoffStartRequest {
  intervention: TakeoverInterventionRef;
  principalBinding: string;
  target: TakeoverHostTarget;
  inputPolicy: WebSocketTakeoverInputPolicy;
}

/**
 * Explicit WSS-only bounded Window component for acceptance and deployments that intentionally do
 * not want ICE/STUN/TURN. It composes the same Handoff authority/session/generation machinery with
 * an OS exact-window surface; it never instantiates a WebRTC runtime or widens to a desktop.
 *
 * Normal consumers should prefer `WindowHandoffAdapter` when transport selection is managed by
 * Handoff. This facade exists so WSS itself can be independently accepted and reused without
 * reconstructing the low-level WebSocket broker/surface stack in each consumer.
 */
export class WindowWebSocketHandoffAdapter {
  readonly #surface: ExperimentalWebSocketWindowSurface;
  readonly #handoff: WebSocketBrowserHandoff;
  readonly #secureLocalAuthentication: boolean;
  readonly #latencyTracker = new WebSocketLatencyTracker();

  constructor(config: WindowWebSocketHandoffAdapterConfig) {
    this.#surface = makeSurface(
      config.host,
      config.successorWindowPolicy,
      config.onOperatorDiagnosticEvent,
      this.#latencyTracker
    );
    this.#secureLocalAuthentication = config.host.platform === "macos"
      && config.host.initialSecureWindowPolicy?.mode === "macos_local_authentication";
    this.#handoff = new WebSocketBrowserHandoff({
      takeover: config.takeover,
      allowedOrigins: config.allowedOrigins,
      surface: this.#surface,
      ...(config.frameIntervalMs === undefined ? {} : { frameIntervalMs: config.frameIntervalMs }),
      ...(config.maxInboundBytes === undefined ? {} : { maxInboundBytes: config.maxInboundBytes }),
      ...(config.onOperatorDiagnosticEvent
        ? { onDiagnosticEvent: config.onOperatorDiagnosticEvent }
        : {}),
      ...(config.onComplete ? { onComplete: config.onComplete } : {}),
      latencyTracker: this.#latencyTracker
    });
  }

  start(request: WindowWebSocketHandoffStartRequest): string {
    if (this.#secureLocalAuthentication) {
      if (request.target.windowId !== undefined) {
        throw new Error("LocalAuthentication WSS resolves the exact secure Window from PID only");
      }
      if (!localAuthenticationInputPolicy(request.inputPolicy)) {
        throw new Error("LocalAuthentication WSS permits Human tap plus secure text/backspace only");
      }
    } else if (!Number.isSafeInteger(request.target.windowId) || (request.target.windowId ?? 0) <= 0) {
      throw new Error("WSS-only Window Handoff requires one exact positive Window id");
    }
    return this.#handoff.start(request);
  }

  handle(request: Request, boundPrincipal: string | undefined): Promise<Response> {
    return this.#handoff.handle(request, boundPrincipal);
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    return this.#handoff.handleUpgrade(request, socket, head);
  }

  ownsPath(pathname: string): boolean { return this.#handoff.ownsPath(pathname); }
  revoke(interventionId: string): void { this.#handoff.revoke(interventionId); }

  /** Human Done is insufficient; only the consumer may call this after fresh semantic verification. */
  async completeAfterVerification(intervention: TakeoverInterventionRef): Promise<boolean> {
    return await this.#handoff.completeAfterVerification(intervention);
  }

  /** Content-free WSS authority/transport diagnostics. */
  diagnosticsSnapshot(): ReturnType<WebSocketBrowserHandoff["diagnosticsSnapshot"]> {
    return this.#handoff.diagnosticsSnapshot();
  }

  /** @internal Content-free startup/cadence latency evidence for WSS-only physical acceptance. */
  latencySnapshot(): WebSocketLatencySnapshot {
    return this.#handoff.latencySnapshot();
  }

  async close(): Promise<void> { await this.#surface.close?.(); }
}

function makeSurface(
  host: WindowWebSocketHostConfig,
  successorWindowPolicy: { mode: "same_process"; transitionWindowMs?: number } | undefined,
  onDiagnosticEvent: ((kind: ManagedOperatorDiagnosticEventKind) => void) | undefined,
  latencyTracker: WebSocketLatencyTracker
): ExperimentalWebSocketWindowSurface {
  if (host.platform === "macos") {
    return new MacOSWebSocketWindowSurface({
      hostExecutable: host.hostExecutable,
      ...(host.helperTtlMs === undefined ? {} : { helperTtlMs: host.helperTtlMs }),
      ...(host.initialSecureWindowPolicy
        ? { initialSecureWindowPolicy: host.initialSecureWindowPolicy }
        : {}),
      ...(successorWindowPolicy ? { successorWindowPolicy } : {}),
      ...(onDiagnosticEvent ? { onDiagnosticEvent } : {}),
      latencyTracker
    });
  }
  if (successorWindowPolicy) {
    throw new Error("Linux WSS does not support macOS successor-window lineage");
  }
  return new LinuxWebSocketWindowSurface({
    hostScript: host.hostScript,
    displayName: host.displayName,
    ...(host.xdotoolExecutable === undefined ? {} : { xdotoolExecutable: host.xdotoolExecutable }),
    ...(host.authorityHelperExecutable === undefined
      ? {}
      : { authorityHelperExecutable: host.authorityHelperExecutable }),
    ...(host.helperTtlMs === undefined ? {} : { helperTtlMs: host.helperTtlMs }),
    ...(onDiagnosticEvent ? { onDiagnosticEvent } : {}),
    latencyTracker
  });
}

function localAuthenticationInputPolicy(policy: WebSocketTakeoverInputPolicy): boolean {
  return policy.tap === true && policy.scroll === false && policy.text === true && policy.key === true;
}
