import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket from "ws";
import { TakeoverSessionManager, type TakeoverCompletionResult } from "../browser-takeover/session.js";
import { type WebSocketTakeoverBinding, type WebSocketTakeoverFrame, type WebSocketTakeoverHumanInput, type WebSocketTakeoverInputPolicy, type WebSocketTakeoverLease, type WebSocketTakeoverPeer, type WebSocketTakeoverServerMessage, type WebSocketTakeoverState, type WebSocketTakeoverFailureCode, type WebSocketTakeoverInputStage } from "./websocket-takeover.js";
import type { ManagedOperatorDiagnosticEventKind } from "./managed-operator-diagnostics.js";
import type { WebSocketLatencyTracker } from "./websocket-latency.js";
export interface ExperimentalWebSocketAcceptedSession {
    readonly binding: WebSocketTakeoverBinding;
    readonly inputPolicy: WebSocketTakeoverInputPolicy;
    readonly lease: WebSocketTakeoverLease;
}
export interface ExperimentalWebSocketTakeoverSessionAuthorityHooks {
    completed?(completion: TakeoverCompletionResult): void | Promise<void>;
}
/**
 * Handoff-owned WSS authentication/claim authority.
 *
 * The browser receives only an opaque bearer ticket after the existing HTTPS request has already
 * been bound to a principal. The WebSocket handshake presents that ticket as a subprotocol token;
 * principal, intervention, epoch, client binding and generation are all recovered or minted on the
 * server and never accepted from peer messages.
 *
 * Reconnect state is session-scoped rather than ticket-scoped. A fresh authenticated HTTPS
 * bootstrap may rotate the short-lived handshake ticket without losing the server-held reconnect
 * handle or silently reviving a stale client generation.
 */
export declare class ExperimentalWebSocketTakeoverSessionAuthority {
    #private;
    private readonly sessions;
    private readonly now;
    private readonly createTicket;
    private readonly createClientBinding;
    private readonly hooks;
    constructor(sessions: TakeoverSessionManager, now?: () => number, createTicket?: () => string, createClientBinding?: () => string, hooks?: ExperimentalWebSocketTakeoverSessionAuthorityHooks);
    issueHandshakeTicket(sessionId: string, boundPrincipal: string, inputPolicy: WebSocketTakeoverInputPolicy): string;
    accept(sessionId: string, ticket: string): ExperimentalWebSocketAcceptedSession;
    invalidateTicket(ticket: string): void;
    revokeSession(sessionId: string): void;
}
export interface ExperimentalWebSocketTakeoverIngressOptions {
    authority: ExperimentalWebSocketTakeoverSessionAuthority;
    allowedOrigins: readonly string[];
    onInput(binding: Readonly<WebSocketTakeoverBinding>, input: WebSocketTakeoverHumanInput): void | Promise<void>;
    maxInboundBytes?: number;
    /** Content-free bounded event hook for first-class managed operator diagnostics. */
    onDiagnosticEvent?: (kind: ManagedOperatorDiagnosticEventKind) => void;
    latencyTracker?: WebSocketLatencyTracker;
}
export type ExperimentalWebSocketIngressDisconnectKind = "none" | "peer_close" | "peer_error" | "policy_close" | "channel_failure";
export interface ExperimentalWebSocketIngressDiagnostics {
    disconnectKind: ExperimentalWebSocketIngressDisconnectKind;
    channelState: WebSocketTakeoverState | "none";
    sentFrames: number;
    droppedFrames: number;
    lastFailure: WebSocketTakeoverFailureCode | "none";
    lastInputStage: WebSocketTakeoverInputStage;
    failureDisconnectKind: ExperimentalWebSocketIngressDisconnectKind;
    failureChannelState: WebSocketTakeoverState | "none";
    failureCode: WebSocketTakeoverFailureCode | "none";
    failureInputStage: WebSocketTakeoverInputStage;
}
/** Concrete Node HTTPS/WSS ingress for the experimental WebSocket transport carrying Browser Handoff. */
export declare class ExperimentalWebSocketTakeoverIngress {
    #private;
    private readonly options;
    constructor(options: ExperimentalWebSocketTakeoverIngressOptions);
    /**
     * Handoff-owned HTTPS bootstrap for a browser that is already authenticated by the enclosing
     * Handoff HTTP boundary. `boundPrincipal` and `inputPolicy` are trusted server-side arguments;
     * no peer-controlled request body can provide or override either value.
     */
    handleBootstrap(request: Request, boundPrincipal: string | undefined, inputPolicy: WebSocketTakeoverInputPolicy): Response | undefined;
    /**
     * Handle a Node `upgrade` event. Returns true only when this ingress owns the requested path.
     * Authentication, Origin validation and one-client claim all happen before a channel receives a
     * trusted binding.
     */
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
    hasActiveConnection(sessionId: string): boolean;
    /** @internal Content-free WebSocket transport diagnostics for managed physical acceptance. */
    diagnosticsSnapshot(): ExperimentalWebSocketIngressDiagnostics;
    pushFrame(sessionId: string, frame: WebSocketTakeoverFrame): Promise<boolean>;
    pushControl(sessionId: string, message: WebSocketTakeoverServerMessage): Promise<boolean>;
    revoke(sessionId: string): Promise<void>;
}
export declare class NodeWebSocketTakeoverPeer implements WebSocketTakeoverPeer {
    #private;
    private readonly webSocket;
    constructor(webSocket: WebSocket);
    sendControl(message: WebSocketTakeoverServerMessage): Promise<void>;
    sendFrame(frame: WebSocketTakeoverFrame): Promise<void>;
    bufferedAmount(): number;
    close(code: number, reason: string): Promise<void>;
}
//# sourceMappingURL=websocket-ingress.d.ts.map