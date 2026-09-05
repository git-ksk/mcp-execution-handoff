import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { TakeoverCompletionEvent, TakeoverHostTarget, TakeoverInterventionRef } from "../browser-takeover/broker.js";
import type { TakeoverBrokerConfig } from "../browser-takeover/broker.js";
import { ExperimentalWebSocketBrowserHandoff as WebSocketBrowserHandoff } from "../browser-takeover/websocket-browser-handoff.js";
import { type MacOSWebSocketWindowSurfaceConfig } from "../browser-takeover/macos-websocket-window-surface.js";
import type { ManagedOperatorDiagnosticEventKind } from "../browser-takeover/managed-operator-diagnostics.js";
import type { WebSocketTakeoverInputPolicy } from "../browser-takeover/websocket-takeover.js";
import { type WebSocketLatencySnapshot } from "../browser-takeover/websocket-latency.js";
export interface MacOSWindowWebSocketHostConfig extends Omit<MacOSWebSocketWindowSurfaceConfig, "onDiagnosticEvent" | "successorWindowPolicy" | "latencyTracker"> {
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
export type WindowWebSocketHostConfig = MacOSWindowWebSocketHostConfig | LinuxWindowWebSocketHostConfig;
export interface WindowWebSocketHandoffAdapterConfig {
    takeover: TakeoverBrokerConfig;
    allowedOrigins: readonly string[];
    host: WindowWebSocketHostConfig;
    frameIntervalMs?: number;
    maxInboundBytes?: number;
    successorWindowPolicy?: {
        mode: "same_process";
        transitionWindowMs?: number;
    };
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
export declare class WindowWebSocketHandoffAdapter {
    #private;
    constructor(config: WindowWebSocketHandoffAdapterConfig);
    start(request: WindowWebSocketHandoffStartRequest): string;
    handle(request: Request, boundPrincipal: string | undefined): Promise<Response>;
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
    ownsPath(pathname: string): boolean;
    revoke(interventionId: string): void;
    /** Human Done is insufficient; only the consumer may call this after fresh semantic verification. */
    completeAfterVerification(intervention: TakeoverInterventionRef): Promise<boolean>;
    /** Content-free WSS authority/transport diagnostics. */
    diagnosticsSnapshot(): ReturnType<WebSocketBrowserHandoff["diagnosticsSnapshot"]>;
    /** @internal Content-free startup/cadence latency evidence for WSS-only physical acceptance. */
    latencySnapshot(): WebSocketLatencySnapshot;
    close(): Promise<void>;
}
//# sourceMappingURL=window-websocket-handoff-adapter.d.ts.map