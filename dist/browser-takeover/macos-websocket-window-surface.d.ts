import type { TakeoverHostTarget } from "./broker.js";
import type { ManagedOperatorDiagnosticEventKind } from "./managed-operator-diagnostics.js";
import type { ManagedWindowWebSocketSurfaceDiagnostics } from "./websocket-window-surface-diagnostics.js";
import type { ExperimentalWebSocketWindowCaptureFailureDisposition, ExperimentalWebSocketWindowInputFailureDisposition, ExperimentalWebSocketWindowSurface } from "./websocket-window-handoff.js";
import type { WebSocketTakeoverEditableRegion, WebSocketTakeoverFrame } from "./websocket-takeover.js";
export interface MacOSWebSocketWindowSurfaceConfig {
    /** Absolute built `takeover-webrtc-host` path. The helper is local-only; WSS is owned by Node. */
    hostExecutable: string;
    helperTtlMs?: number;
    /** Explicit opt-in for Apple's exact LocalAuthentication passcode dialog. */
    initialSecureWindowPolicy?: {
        mode: "macos_local_authentication";
    };
    /** Content-free bounded event hook owned by Handoff diagnostics. */
    onDiagnosticEvent?: (kind: ManagedOperatorDiagnosticEventKind) => void;
}
export type MacOSWebSocketSurfaceFailure = "none" | "frame_timeout" | "helper_closed" | "helper_error" | "frame_protocol" | "diagnostics_bounds" | "input_failure" | "input_timeout" | "input_rejected" | "authority_lost";
export type MacOSWebSocketInputStage = "none" | "requested" | "command_sent" | "applied" | "rejected";
/**
 * macOS exact-window WSS surface backed by the same reviewed local ScreenCaptureKit/AX/CGEvent
 * helper used by Window WebRTC. This class owns no WebRTC objects and never widens to display
 * capture. The helper receives only the already-authorized PID/window boundary through local env.
 */
export declare class MacOSWebSocketWindowSurface implements ExperimentalWebSocketWindowSurface {
    #private;
    constructor(config: MacOSWebSocketWindowSurfaceConfig);
    diagnosticsSnapshot(): {
        lastFailure: MacOSWebSocketSurfaceFailure;
        failure: MacOSWebSocketSurfaceFailure;
        framesObserved: number;
        inputAttempts: number;
        lastInputStage: MacOSWebSocketInputStage;
        authorityBoundary: "valid" | "lost";
    };
    /** OS-neutral projection used by managed Browser/Window composition. */
    managedDiagnosticsSnapshot(): ManagedWindowWebSocketSurfaceDiagnostics;
    captureFailureDisposition(_error: unknown): ExperimentalWebSocketWindowCaptureFailureDisposition;
    inputFailureDisposition(error: unknown): ExperimentalWebSocketWindowInputFailureDisposition;
    editableRegionsSnapshot(): WebSocketTakeoverEditableRegion[];
    captureExactWindow(target: Readonly<TakeoverHostTarget>): Promise<WebSocketTakeoverFrame>;
    tapExactWindow(target: Readonly<TakeoverHostTarget>, x: number, y: number): Promise<void>;
    scrollExactWindow(target: Readonly<TakeoverHostTarget>, deltaY: number): Promise<void>;
    insertExactWindowText(target: Readonly<TakeoverHostTarget>, text: string): Promise<void>;
    pressExactWindowKey(target: Readonly<TakeoverHostTarget>, key: string): Promise<void>;
    close(): Promise<void>;
}
//# sourceMappingURL=macos-websocket-window-surface.d.ts.map