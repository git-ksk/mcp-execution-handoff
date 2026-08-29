import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type TakeoverBrokerConfig, type TakeoverCompletionEvent, type TakeoverHostTarget, type TakeoverInterventionRef } from "../browser-takeover/broker.js";
import { ExperimentalWebSocketBrokerBinding } from "./websocket-broker-binding.js";
import type { WebSocketTakeoverFrame, WebSocketTakeoverInputPolicy } from "./websocket-takeover.js";
export type ExperimentalWebSocketWindowCaptureFailureDisposition = "recoverable" | "authority_lost";
export interface ExperimentalWebSocketWindowSurface {
    /**
     * Capture only the supplied exact process/window boundary. Implementations must fail closed when
     * the target is missing, ambiguous, moved outside the authorized boundary, or otherwise cannot
     * be revalidated. They must never widen to a display/desktop capture.
     */
    captureExactWindow(target: Readonly<TakeoverHostTarget>): Promise<WebSocketTakeoverFrame>;
    /** Unknown failures default to authority_lost so generic surfaces remain fail closed. */
    captureFailureDisposition?(error: unknown): ExperimentalWebSocketWindowCaptureFailureDisposition;
    tapExactWindow(target: Readonly<TakeoverHostTarget>, x: number, y: number): Promise<void>;
    scrollExactWindow(target: Readonly<TakeoverHostTarget>, deltaY: number): Promise<void>;
    insertExactWindowText(target: Readonly<TakeoverHostTarget>, text: string): Promise<void>;
    pressExactWindowKey(target: Readonly<TakeoverHostTarget>, key: string): Promise<void>;
}
export interface ExperimentalWebSocketWindowHandoffConfig {
    takeover: TakeoverBrokerConfig;
    allowedOrigins: readonly string[];
    surface: ExperimentalWebSocketWindowSurface;
    frameIntervalMs?: number;
    maxInboundBytes?: number;
    /** Called only after the shared Human generation has been fenced. */
    onComplete?: (event: TakeoverCompletionEvent) => void | Promise<void>;
}
export interface ExperimentalWebSocketWindowStartRequest {
    intervention: TakeoverInterventionRef;
    principalBinding: string;
    target: TakeoverHostTarget;
    inputPolicy: WebSocketTakeoverInputPolicy;
}
export declare class ExperimentalWebSocketWindowHandoffError extends Error {
    readonly code: "WINDOW_HANDOFF_UNAVAILABLE" | "WINDOW_HANDOFF_TARGET_INVALID" | "WINDOW_HANDOFF_INPUT_POLICY_INVALID";
    constructor(code: "WINDOW_HANDOFF_UNAVAILABLE" | "WINDOW_HANDOFF_TARGET_INVALID" | "WINDOW_HANDOFF_INPUT_POLICY_INVALID", message: string);
}
/**
 * Private Generic Window composition for the #40 WSS experiment.
 *
 * Consumers still provide only Handoff semantics plus an exact Window target. WSS framing,
 * bootstrap tickets, connection state and frame pumping remain Handoff-owned. The exact target is
 * retained only in process memory and is never sent to the browser or stored in transport messages.
 */
export declare class ExperimentalWebSocketWindowHandoff {
    #private;
    constructor(config: ExperimentalWebSocketWindowHandoffConfig);
    start(request: ExperimentalWebSocketWindowStartRequest): string;
    authorizeClientPage(sessionId: string, boundPrincipal: string | undefined): boolean;
    /** @internal Content-free WSS ingress diagnostics for managed physical acceptance. */
    diagnosticsSnapshot(): ReturnType<ExperimentalWebSocketBrokerBinding["diagnosticsSnapshot"]>;
    handle(request: Request, boundPrincipal: string | undefined): Promise<Response> | Response;
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
    ownsPath(pathname: string): boolean;
    revoke(interventionId: string): void;
}
//# sourceMappingURL=websocket-window-handoff.d.ts.map