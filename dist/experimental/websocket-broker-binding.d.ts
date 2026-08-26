import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { TakeoverBroker, TakeoverInterventionRef } from "../browser-takeover/broker.js";
import type { WebSocketTakeoverBinding, WebSocketTakeoverFrame, WebSocketTakeoverHumanInput, WebSocketTakeoverInputPolicy } from "./websocket-takeover.js";
export interface ExperimentalWebSocketBrokerBindingOptions {
    allowedOrigins: readonly string[];
    onInput(binding: Readonly<WebSocketTakeoverBinding>, input: WebSocketTakeoverHumanInput): void | Promise<void>;
    maxInboundBytes?: number;
}
/**
 * Experimental bridge that binds WSS to the exact TakeoverBroker session authority.
 *
 * This module is intentionally absent from package exports while #40 physical Acceptance is open.
 * Transport choice therefore stays an internal coordinator concern rather than a stable consumer
 * API. Native, WebRTC, legacy HTTP and WSS all fence through the same TakeoverSessionManager.
 */
export declare class ExperimentalWebSocketBrokerBinding {
    #private;
    constructor(broker: TakeoverBroker, options: ExperimentalWebSocketBrokerBindingOptions);
    createLink(intervention: TakeoverInterventionRef, principalBinding: string | undefined, inputPolicy: WebSocketTakeoverInputPolicy): string | undefined;
    handleBootstrap(request: Request, boundPrincipal: string | undefined): Response | undefined;
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
    hasActiveConnection(sessionId: string): boolean;
    pushFrame(sessionId: string, frame: WebSocketTakeoverFrame): Promise<boolean>;
    revoke(sessionId: string): void;
}
//# sourceMappingURL=websocket-broker-binding.d.ts.map