import type { SpawnedWebRtcRuntimeProviderConfig } from "./webrtc-runtime.js";
import type { ManagedOperatorDiagnosticEventKind } from "./managed-operator-diagnostics.js";
import type { ExperimentalWebSocketWindowSurface } from "./websocket-window-handoff.js";
import type { ManagedWindowWebSocketSurfaceDiagnostics } from "./websocket-window-surface-diagnostics.js";
import type { WebSocketLatencyTracker } from "./websocket-latency.js";
import {
  ExperimentalLinuxWebSocketWindowSurface as LinuxWebSocketWindowSurface
} from "./linux-websocket-window-surface.js";
import { MacOSWebSocketWindowSurface } from "./macos-websocket-window-surface.js";

export type ManagedWindowWebSocketPlatform = "auto" | "macos" | "linux";

/** Deployment-owned host configuration. It never appears in a semantic Handoff start request. */
export interface ManagedWindowWebSocketHostConfig {
  platform?: ManagedWindowWebSocketPlatform;
  /** Linux exact-window host script. Required only when the selected host is Linux. */
  linuxHostScript?: string;
  /** Linux local X11 display. Defaults to the WebRTC runtime display. */
  displayName?: string;
  xdotoolExecutable?: string;
  authorityHelperExecutable?: string;
  /** macOS helper override. Defaults to the same reviewed runtime host executable used by WebRTC. */
  macosHostExecutable?: string;
}

export interface ManagedWindowWebSocketSurface extends ExperimentalWebSocketWindowSurface {
  close(): Promise<void>;
  managedDiagnosticsSnapshot(): ManagedWindowWebSocketSurfaceDiagnostics;
}

export interface ManagedWindowWebSocketSurfaceFactoryConfig {
  host: ManagedWindowWebSocketHostConfig;
  runtime: SpawnedWebRtcRuntimeProviderConfig;
  helperTtlMs: number;
  initialSecureWindowPolicy?: { mode: "macos_local_authentication" };
  successorWindowPolicy?: { mode: "same_process"; transitionWindowMs?: number };
  onDiagnosticEvent?: (kind: ManagedOperatorDiagnosticEventKind) => void;
  latencyTracker?: WebSocketLatencyTracker;
}

export function resolveManagedWindowWebSocketPlatform(
  host: ManagedWindowWebSocketHostConfig
): Exclude<ManagedWindowWebSocketPlatform, "auto"> {
  const configured = host.platform ?? "auto";
  if (configured !== "auto" && configured !== "macos" && configured !== "linux") {
    throw new Error("Managed Window WSS platform is invalid");
  }
  if (configured === "macos" || configured === "linux") return configured;
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  throw new Error("Managed Window WSS is unsupported on this host platform");
}

/** Construct one exact-window WSS surface without exposing a concrete OS class to consumers. */
export function createManagedWindowWebSocketSurface(
  config: ManagedWindowWebSocketSurfaceFactoryConfig
): ManagedWindowWebSocketSurface {
  const platform = resolveManagedWindowWebSocketPlatform(config.host);
  if (platform === "macos") {
    return new MacOSWebSocketWindowSurface({
      hostExecutable: config.host.macosHostExecutable ?? config.runtime.hostExecutable,
      helperTtlMs: config.helperTtlMs,
      ...(config.initialSecureWindowPolicy
        ? { initialSecureWindowPolicy: config.initialSecureWindowPolicy }
        : {}),
      ...(config.successorWindowPolicy
        ? { successorWindowPolicy: config.successorWindowPolicy }
        : {}),
      ...(config.onDiagnosticEvent ? { onDiagnosticEvent: config.onDiagnosticEvent } : {})
    });
  }
  if (config.initialSecureWindowPolicy) {
    throw new Error("Managed Linux WSS does not support macOS LocalAuthentication authority");
  }
  if (config.successorWindowPolicy) {
    throw new Error("Managed Linux WSS does not support macOS successor-window lineage");
  }
  const displayName = config.host.displayName ?? config.runtime.displayName;
  if (!config.host.linuxHostScript || !displayName) {
    throw new Error("Managed Linux WSS requires an exact-window host script and local X11 display");
  }
  return new LinuxWebSocketWindowSurface({
    hostScript: config.host.linuxHostScript,
    displayName,
    helperTtlMs: config.helperTtlMs,
    ...(config.host.xdotoolExecutable ? { xdotoolExecutable: config.host.xdotoolExecutable } : {}),
    ...(config.host.authorityHelperExecutable
      ? { authorityHelperExecutable: config.host.authorityHelperExecutable }
      : {}),
    ...(config.onDiagnosticEvent ? { onDiagnosticEvent: config.onDiagnosticEvent } : {}),
    ...(config.latencyTracker ? { latencyTracker: config.latencyTracker } : {})
  });
}
