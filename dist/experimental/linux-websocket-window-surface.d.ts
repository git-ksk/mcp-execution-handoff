import type { TakeoverHostTarget } from "../browser-takeover/broker.js";
import type { ExperimentalWebSocketWindowSurface } from "./websocket-window-handoff.js";
import type { WebSocketTakeoverFrame } from "./websocket-takeover.js";
export interface ExperimentalLinuxWebSocketWindowSurfaceConfig {
    hostScript: string;
    displayName: string;
    xdotoolExecutable?: string;
    helperTtlMs?: number;
}
export interface LinuxWebSocketJpegFrame {
    data: Buffer;
    width: number;
    height: number;
}
/** Parses only the private JPEG record emitted by the existing Linux exact-window host helper. */
export declare class LinuxWebSocketHostRecordParser {
    #private;
    private readonly onFrame;
    constructor(onFrame: (frame: LinuxWebSocketJpegFrame) => void);
    push(chunk: Buffer): void;
}
/**
 * Private Linux physical-Acceptance surface for the #40 WSS experiment.
 *
 * It deliberately reuses the existing normal-browser exact-window helper. The helper still owns
 * X11 target resolution, capture and Human input. This adapter selects its JPEG-only stdout mode,
 * keeps the process/window tuple server-side, revalidates that exact tuple before every returned
 * frame/input, and never exposes helper transport details to Browser/Window consumers.
 */
export declare class ExperimentalLinuxWebSocketWindowSurface implements ExperimentalWebSocketWindowSurface {
    #private;
    constructor(config: ExperimentalLinuxWebSocketWindowSurfaceConfig);
    captureExactWindow(target: Readonly<TakeoverHostTarget>): Promise<WebSocketTakeoverFrame>;
    tapExactWindow(target: Readonly<TakeoverHostTarget>, x: number, y: number): Promise<void>;
    scrollExactWindow(target: Readonly<TakeoverHostTarget>, deltaY: number): Promise<void>;
    insertExactWindowText(target: Readonly<TakeoverHostTarget>, text: string): Promise<void>;
    pressExactWindowKey(target: Readonly<TakeoverHostTarget>, key: string): Promise<void>;
    close(): Promise<void>;
}
//# sourceMappingURL=linux-websocket-window-surface.d.ts.map