import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { TakeoverCompletionEvent, TakeoverHostTarget, TakeoverInterventionRef } from "../browser-takeover/broker.js";
import { ExperimentalWebSocketWindowHandoff, type ExperimentalWebSocketWindowHandoffConfig, type ExperimentalWebSocketWindowSurface } from "./websocket-window-handoff.js";
import type { WebSocketTakeoverInputPolicy } from "./websocket-takeover.js";
import type { ManagedOperatorDiagnosticEventKind } from "./managed-operator-diagnostics.js";
export interface ExperimentalWebSocketBrowserHandoffConfig {
    takeover: ExperimentalWebSocketWindowHandoffConfig["takeover"];
    allowedOrigins: readonly string[];
    surface: ExperimentalWebSocketWindowSurface;
    frameIntervalMs?: number;
    maxInboundBytes?: number;
    onDiagnosticEvent?: (kind: ManagedOperatorDiagnosticEventKind) => void;
    onComplete?: (event: TakeoverCompletionEvent) => void | Promise<void>;
}
export interface ExperimentalWebSocketBrowserStartRequest {
    intervention: TakeoverInterventionRef;
    principalBinding: string;
    target: TakeoverHostTarget;
    inputPolicy: WebSocketTakeoverInputPolicy;
}
/**
 * Private normal-browser facade for the #40 WSS experiment.
 *
 * Browser profile/auth semantics remain consumer-owned. This class serves only Handoff's locator
 * page and WSS transport UI; it never receives account identity, cookies, credentials, or target
 * service metadata. Exact process/window enforcement stays in the shared Window composition.
 */
export declare class ExperimentalWebSocketBrowserHandoff {
    #private;
    constructor(config: ExperimentalWebSocketBrowserHandoffConfig);
    start(request: ExperimentalWebSocketBrowserStartRequest): string;
    handle(request: Request, boundPrincipal: string | undefined): Promise<Response>;
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
    ownsPath(pathname: string): boolean;
    /** @internal Content-free WSS ingress diagnostics for managed physical acceptance. */
    diagnosticsSnapshot(): ReturnType<ExperimentalWebSocketWindowHandoff["diagnosticsSnapshot"]>;
    revoke(interventionId: string): void;
}
//# sourceMappingURL=websocket-browser-handoff.d.ts.map