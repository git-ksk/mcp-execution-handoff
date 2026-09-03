import type { SpawnedWebRtcRuntimeProviderConfig } from "./webrtc-runtime.js";
import type { ManagedOperatorDiagnosticEventKind } from "./managed-operator-diagnostics.js";
import type { ExperimentalWebSocketWindowSurface } from "./websocket-window-handoff.js";
import type { ManagedWindowWebSocketSurfaceDiagnostics } from "./websocket-window-surface-diagnostics.js";
import type { WebSocketLatencyTracker } from "./websocket-latency.js";
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
    initialSecureWindowPolicy?: {
        mode: "macos_local_authentication";
    };
    successorWindowPolicy?: {
        mode: "same_process";
        transitionWindowMs?: number;
    };
    onDiagnosticEvent?: (kind: ManagedOperatorDiagnosticEventKind) => void;
    latencyTracker?: WebSocketLatencyTracker;
}
export declare function resolveManagedWindowWebSocketPlatform(host: ManagedWindowWebSocketHostConfig): Exclude<ManagedWindowWebSocketPlatform, "auto">;
/** Construct one exact-window WSS surface without exposing a concrete OS class to consumers. */
export declare function createManagedWindowWebSocketSurface(config: ManagedWindowWebSocketSurfaceFactoryConfig): ManagedWindowWebSocketSurface;
//# sourceMappingURL=managed-window-websocket-surface.d.ts.map