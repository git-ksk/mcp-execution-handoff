import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import {
  TakeoverSessionError,
  TakeoverSessionManager,
  type TakeoverCompletionResult
} from "../browser-takeover/session.js";
import {
  ExperimentalWebSocketTakeoverChannel,
  type WebSocketTakeoverBinding,
  type WebSocketTakeoverFrame,
  type WebSocketTakeoverHumanInput,
  type WebSocketTakeoverInputPolicy,
  type WebSocketTakeoverLease,
  type WebSocketTakeoverPeer,
  type WebSocketTakeoverServerMessage,
  type WebSocketTakeoverState,
  type WebSocketTakeoverFailureCode,
  type WebSocketTakeoverInputStage
} from "./websocket-takeover.js";
import type { ManagedOperatorDiagnosticEventKind } from "./managed-operator-diagnostics.js";

const HANDOFF_SUBPROTOCOL = "mcp-handoff.websocket.v1";
const HANDSHAKE_PROTOCOL_PREFIX = "mcp-handoff-auth.";
const SESSION_PATH = /^\/takeover\/ws\/([A-Za-z0-9-]{8,100})$/;
const BOOTSTRAP_PATH = /^\/takeover\/api\/websocket-bootstrap\/([A-Za-z0-9-]{8,100})$/;
const DEFAULT_MAX_INBOUND_BYTES = 8 * 1024;
const ABSOLUTE_MAX_INBOUND_BYTES = 64 * 1024;
const FRAME_HEADER_BYTES = 16;
const FRAME_MAGIC = 0x484f4631; // HOF1
const POLICY_CLOSE = 1008;
const INTERNAL_CLOSE = 1011;

interface WebSocketSessionRecord {
  readonly sessionId: string;
  readonly principalBinding: string;
  readonly expiresAt: number;
  readonly inputPolicy: WebSocketTakeoverInputPolicy;
  readonly completionCapability: string;
  ticket?: string;
  reconnectHandle?: string;
  currentClientBinding?: string;
  currentGeneration?: number;
}

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
export class ExperimentalWebSocketTakeoverSessionAuthority {
  readonly #sessionsById = new Map<string, WebSocketSessionRecord>();
  readonly #sessionsByTicket = new Map<string, WebSocketSessionRecord>();

  constructor(
    private readonly sessions: TakeoverSessionManager,
    private readonly now: () => number = Date.now,
    private readonly createTicket: () => string = () => randomBytes(32).toString("base64url"),
    private readonly createClientBinding: () => string = () => randomBytes(24).toString("base64url"),
    private readonly hooks: ExperimentalWebSocketTakeoverSessionAuthorityHooks = {}
  ) {}

  issueHandshakeTicket(
    sessionId: string,
    boundPrincipal: string,
    inputPolicy: WebSocketTakeoverInputPolicy
  ): string {
    validateInputPolicy(inputPolicy);
    this.#pruneExpired();
    const locator = this.sessions.validateLocator(sessionId, boundPrincipal);
    let record = this.#sessionsById.get(sessionId);
    if (record) {
      if (
        !safeEqual(record.principalBinding, boundPrincipal) ||
        !sameInputPolicy(record.inputPolicy, inputPolicy)
      ) {
        throw new TakeoverSessionError("TAKEOVER_FORBIDDEN", "Takeover session is unavailable");
      }
    } else {
      record = {
        sessionId,
        principalBinding: boundPrincipal,
        expiresAt: locator.expiresAt,
        inputPolicy: { ...inputPolicy },
        completionCapability: this.sessions.issueCompletionCapability(sessionId, boundPrincipal)
      };
      this.#sessionsById.set(sessionId, record);
    }

    if (record.ticket) this.#sessionsByTicket.delete(record.ticket);
    const ticket = this.createTicket();
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(ticket) || this.#sessionsByTicket.has(ticket)) {
      throw new Error("WebSocket handshake ticket generator returned an invalid ticket");
    }
    record.ticket = ticket;
    this.#sessionsByTicket.set(ticket, record);
    return ticket;
  }

  accept(sessionId: string, ticket: string): ExperimentalWebSocketAcceptedSession {
    this.#pruneExpired();
    const record = this.#sessionsByTicket.get(ticket);
    if (
      !record ||
      !record.ticket ||
      !safeEqual(record.ticket, ticket) ||
      !safeEqual(record.sessionId, sessionId) ||
      this.now() >= record.expiresAt
    ) {
      throw new TakeoverSessionError("TAKEOVER_FORBIDDEN", "Takeover session is unavailable");
    }

    const nextClientBinding = this.createClientBinding();
    if (!/^[A-Za-z0-9_-]{24,128}$/.test(nextClientBinding)) {
      throw new Error("WebSocket client binding generator returned an invalid binding");
    }
    const grant = record.reconnectHandle === undefined
      ? this.sessions.claimClient(sessionId, record.principalBinding, nextClientBinding)
      : this.sessions.reconnectClient(
          sessionId,
          record.principalBinding,
          record.reconnectHandle,
          nextClientBinding
        );
    record.reconnectHandle = grant.reconnectHandle;
    record.currentClientBinding = grant.clientBinding;
    record.currentGeneration = grant.clientGeneration;

    const binding: WebSocketTakeoverBinding = {
      interventionId: grant.interventionId,
      epoch: grant.epoch,
      principalBinding: grant.principalBinding,
      clientBinding: grant.clientBinding,
      clientGeneration: grant.clientGeneration
    };

    return {
      binding,
      inputPolicy: { ...record.inputPolicy },
      lease: this.#leaseFor(record, binding)
    };
  }

  invalidateTicket(ticket: string): void {
    const record = this.#sessionsByTicket.get(ticket);
    if (!record) return;
    this.#sessionsByTicket.delete(ticket);
    if (record.ticket && safeEqual(record.ticket, ticket)) delete record.ticket;
  }

  revokeSession(sessionId: string): void {
    const record = this.#sessionsById.get(sessionId);
    if (record) this.#forgetRecord(record);
    this.sessions.revoke(sessionId);
  }

  #leaseFor(
    record: WebSocketSessionRecord,
    binding: WebSocketTakeoverBinding
  ): WebSocketTakeoverLease {
    const assertRecordBinding = (): void => {
      if (
        record.currentGeneration !== binding.clientGeneration ||
        !record.currentClientBinding ||
        !safeEqual(record.currentClientBinding, binding.clientBinding)
      ) {
        throw new TakeoverSessionError("TAKEOVER_FORBIDDEN", "Takeover generation is stale");
      }
    };

    return {
      beginUse: () => {
        assertRecordBinding();
        this.sessions.beginBoundUse(
          record.sessionId,
          record.principalBinding,
          binding.clientBinding,
          binding.clientGeneration
        );
      },
      endUse: () => {
        this.sessions.endUse(
          record.sessionId,
          record.principalBinding,
          binding.clientBinding,
          binding.clientGeneration
        );
      },
      complete: () => {
        assertRecordBinding();
        const completion = this.sessions.complete(
          record.sessionId,
          record.completionCapability,
          record.principalBinding
        );
        this.#forgetRecord(record);
        return this.hooks.completed?.(completion);
      },
      release: () => {
        // A newer generation already fences an older socket. Treat that as successful cleanup,
        // matching the existing WebRTC disconnected hook rather than reporting a false leak.
        if (
          record.currentGeneration !== binding.clientGeneration ||
          !record.currentClientBinding ||
          !safeEqual(record.currentClientBinding, binding.clientBinding)
        ) {
          return;
        }
        try {
          this.sessions.releaseClientGeneration(
            record.sessionId,
            record.principalBinding,
            binding.clientBinding,
            binding.clientGeneration
          );
        } catch (error) {
          if (
            error instanceof TakeoverSessionError
            && (error.code === "TAKEOVER_NOT_FOUND" || error.code === "TAKEOVER_EXPIRED")
          ) {
            return;
          }
          throw error;
        }
      }
    };
  }

  #pruneExpired(): void {
    const now = this.now();
    for (const record of this.#sessionsById.values()) {
      if (record.expiresAt <= now) this.#forgetRecord(record);
    }
  }

  #forgetRecord(record: WebSocketSessionRecord): void {
    if (record.ticket) this.#sessionsByTicket.delete(record.ticket);
    this.#sessionsById.delete(record.sessionId);
  }
}

export interface ExperimentalWebSocketTakeoverIngressOptions {
  authority: ExperimentalWebSocketTakeoverSessionAuthority;
  allowedOrigins: readonly string[];
  onInput(
    binding: Readonly<WebSocketTakeoverBinding>,
    input: WebSocketTakeoverHumanInput
  ): void | Promise<void>;
  maxInboundBytes?: number;
  /** Content-free bounded event hook for first-class managed operator diagnostics. */
  onDiagnosticEvent?: (kind: ManagedOperatorDiagnosticEventKind) => void;
}

interface ActiveConnection {
  readonly ticket: string;
  readonly binding: WebSocketTakeoverBinding;
  readonly peer: NodeWebSocketTakeoverPeer;
  readonly channel: ExperimentalWebSocketTakeoverChannel;
}

export type ExperimentalWebSocketIngressDisconnectKind =
  | "none"
  | "peer_close"
  | "peer_error"
  | "policy_close"
  | "channel_failure";

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
export class ExperimentalWebSocketTakeoverIngress {
  readonly #origins: ReadonlySet<string>;
  readonly #server: WebSocketServer;
  readonly #maxInboundBytes: number;
  readonly #active = new Map<string, ActiveConnection>();
  #lastDiagnostics: ExperimentalWebSocketIngressDiagnostics = {
    disconnectKind: "none",
    channelState: "none",
    sentFrames: 0,
    droppedFrames: 0,
    lastFailure: "none",
    lastInputStage: "none",
    failureDisconnectKind: "none",
    failureChannelState: "none",
    failureCode: "none",
    failureInputStage: "none"
  };

  constructor(private readonly options: ExperimentalWebSocketTakeoverIngressOptions) {
    this.#origins = normalizeAllowedOrigins(options.allowedOrigins);
    this.#maxInboundBytes = boundedInboundLimit(options.maxInboundBytes);
    this.#server = new WebSocketServer({
      noServer: true,
      maxPayload: this.#maxInboundBytes,
      perMessageDeflate: false,
      handleProtocols(protocols) {
        return protocols.has(HANDOFF_SUBPROTOCOL) ? HANDOFF_SUBPROTOCOL : false;
      }
    });
  }

  /**
   * Handoff-owned HTTPS bootstrap for a browser that is already authenticated by the enclosing
   * Handoff HTTP boundary. `boundPrincipal` and `inputPolicy` are trusted server-side arguments;
   * no peer-controlled request body can provide or override either value.
   */
  handleBootstrap(
    request: Request,
    boundPrincipal: string | undefined,
    inputPolicy: WebSocketTakeoverInputPolicy
  ): Response | undefined {
    const url = new URL(request.url);
    const match = BOOTSTRAP_PATH.exec(url.pathname);
    if (!match) return undefined;
    if (request.method !== "POST") return bootstrapJson(405, { error: "method_not_allowed" });
    if (url.search || url.hash) return bootstrapJson(404, { error: "not_found" });
    if (!boundPrincipal) return bootstrapJson(404, { error: "takeover_unavailable" });
    const origin = request.headers.get("origin");
    if (!origin || !this.#origins.has(origin)) {
      return bootstrapJson(403, { error: "origin_not_allowed" });
    }

    let ticket: string;
    try {
      ticket = this.options.authority.issueHandshakeTicket(match[1]!, boundPrincipal, inputPolicy);
    } catch (error) {
      if (error instanceof TakeoverSessionError) {
        return bootstrapJson(404, { error: "takeover_unavailable" });
      }
      throw error;
    }
    return bootstrapJson(200, {
      protocols: [HANDOFF_SUBPROTOCOL, `${HANDSHAKE_PROTOCOL_PREFIX}${ticket}`]
    });
  }

  /**
   * Handle a Node `upgrade` event. Returns true only when this ingress owns the requested path.
   * Authentication, Origin validation and one-client claim all happen before a channel receives a
   * trusted binding.
   */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const parsed = this.#parseHandshake(request);
    if (parsed === undefined) return false;
    if (parsed instanceof UpgradeRejection) {
      rejectUpgrade(socket, parsed.statusCode);
      return true;
    }

    let accepted: ExperimentalWebSocketAcceptedSession;
    try {
      accepted = this.options.authority.accept(parsed.sessionId, parsed.ticket);
    } catch (error) {
      const status = error instanceof TakeoverSessionError && error.code === "TAKEOVER_CLIENT_ACTIVE"
        ? 409
        : 404;
      rejectUpgrade(socket, status);
      return true;
    }

    try {
      this.#server.handleUpgrade(request, socket, head, (webSocket) => {
        try {
          const peer = new NodeWebSocketTakeoverPeer(webSocket);
          const channel = new ExperimentalWebSocketTakeoverChannel({
            binding: accepted.binding,
            inputPolicy: accepted.inputPolicy,
            peer,
            lease: accepted.lease,
            onInput: (input) => this.options.onInput(accepted.binding, input),
            onClientDiagnostic: (kind) => this.options.onDiagnosticEvent?.(kind),
            maxInboundBytes: this.#maxInboundBytes
          });
          const previous = this.#active.get(parsed.sessionId);
          const active: ActiveConnection = {
            ticket: parsed.ticket,
            binding: accepted.binding,
            peer,
            channel
          };
          this.#active.set(parsed.sessionId, active);
          this.#recordDiagnostics(active, "none");
          if (previous) {
            void previous.channel.disconnect().catch(() => undefined);
            void previous.peer.close(POLICY_CLOSE, "stale_generation").catch(() => undefined);
          }
          this.#wireConnection(parsed.sessionId, active, webSocket);
          void channel.start().catch(() => {
            this.#recordDiagnostics(active, "channel_failure");
            this.options.authority.invalidateTicket(parsed.ticket);
          });
        } catch {
          this.options.authority.invalidateTicket(parsed.ticket);
          void Promise.resolve(accepted.lease.release(accepted.binding)).catch(() => undefined);
          try { webSocket.close(INTERNAL_CLOSE, "transport_failure"); } catch { webSocket.terminate(); }
        }
      });
    } catch {
      void accepted.lease.release(accepted.binding);
      rejectUpgrade(socket, 500);
    }
    return true;
  }

  hasActiveConnection(sessionId: string): boolean {
    return this.#active.get(sessionId)?.channel.state === "open";
  }

  /** @internal Content-free WebSocket transport diagnostics for managed physical acceptance. */
  diagnosticsSnapshot(): ExperimentalWebSocketIngressDiagnostics {
    return { ...this.#lastDiagnostics };
  }

  async pushFrame(sessionId: string, frame: WebSocketTakeoverFrame): Promise<boolean> {
    const active = this.#active.get(sessionId);
    if (!active || active.channel.state !== "open") return false;
    await active.channel.pushFrame(frame);
    return true;
  }

  async pushControl(sessionId: string, message: WebSocketTakeoverServerMessage): Promise<boolean> {
    const active = this.#active.get(sessionId);
    if (!active || active.channel.state !== "open") return false;
    await active.peer.sendControl(message);
    return true;
  }

  async revoke(sessionId: string): Promise<void> {
    const active = this.#active.get(sessionId);
    if (active) {
      this.#active.delete(sessionId);
      await active.channel.revoke().catch(() => undefined);
    }
    this.options.authority.revokeSession(sessionId);
  }

  #wireConnection(sessionId: string, active: ActiveConnection, webSocket: WebSocket): void {
    let disconnected = false;
    let disconnectKind: ExperimentalWebSocketIngressDisconnectKind = "none";
    const disconnectOnce = async (kind: ExperimentalWebSocketIngressDisconnectKind): Promise<void> => {
      if (disconnectKind === "none" || kind === "channel_failure") disconnectKind = kind;
      if (disconnected) return;
      disconnected = true;
      if (this.#active.get(sessionId) === active) this.#active.delete(sessionId);
      await active.channel.disconnect().catch(() => undefined);
      this.#recordDiagnostics(active, disconnectKind);
    };

    webSocket.on("message", (data, isBinary) => {
      if (isBinary || rawDataByteLength(data) > this.#maxInboundBytes) {
        this.options.authority.invalidateTicket(active.ticket);
        void active.peer.close(POLICY_CLOSE, "invalid_message").catch(() => undefined);
        void disconnectOnce("policy_close");
        return;
      }
      const text = rawDataToUtf8(data);
      void active.channel.receiveText(text).catch(() => {
        if (active.channel.state === "failed") {
          this.#recordDiagnostics(active, "channel_failure");
          this.options.authority.invalidateTicket(active.ticket);
        }
      });
    });
    webSocket.once("close", () => {
      const kind = active.channel.diagnostics.lastFailure ? "channel_failure" : "peer_close";
      void disconnectOnce(kind);
    });
    webSocket.once("error", () => {
      void active.peer.close(INTERNAL_CLOSE, "transport_failure").catch(() => undefined);
      void disconnectOnce("peer_error");
    });
  }

  #recordDiagnostics(active: ActiveConnection, kind: ExperimentalWebSocketIngressDisconnectKind): void {
    const previous = this.#lastDiagnostics;
    const channel = active.channel.diagnostics;
    const disconnectKind = channel.lastFailure ? "channel_failure" : kind;
    const captureFailure = this.#lastDiagnostics.failureDisconnectKind === "none"
      && (channel.lastFailure !== undefined || kind === "peer_error");
    this.#lastDiagnostics = {
      disconnectKind,
      channelState: channel.state,
      sentFrames: Math.min(channel.sentFrames, 1_000_000),
      droppedFrames: Math.min(channel.droppedFrames, 1_000_000),
      lastFailure: channel.lastFailure ?? "none",
      lastInputStage: channel.lastInputStage,
      failureDisconnectKind: captureFailure
        ? disconnectKind
        : this.#lastDiagnostics.failureDisconnectKind,
      failureChannelState: captureFailure
        ? channel.state
        : this.#lastDiagnostics.failureChannelState,
      failureCode: captureFailure
        ? channel.lastFailure ?? "transport_failure"
        : this.#lastDiagnostics.failureCode,
      failureInputStage: captureFailure
        ? channel.lastInputStage
        : this.#lastDiagnostics.failureInputStage
    };
    if (channel.state === "open" && previous.channelState !== "open") {
      this.options.onDiagnosticEvent?.("wss_open");
    } else if (channel.state === "failed" || channel.lastFailure !== undefined || kind === "peer_error") {
      if (previous.channelState !== "failed" || previous.failureCode === "none") {
        this.options.onDiagnosticEvent?.("wss_failed");
      }
    } else if (kind !== "none" && previous.disconnectKind === "none") {
      this.options.onDiagnosticEvent?.("wss_degraded");
    }
  }

  #parseHandshake(request: IncomingMessage):
    | { sessionId: string; ticket: string }
    | UpgradeRejection
    | undefined {
    const host = request.headers.host;
    const requestUrl = request.url;
    if (!requestUrl || !host) return undefined;
    let url: URL;
    try {
      url = new URL(requestUrl, `https://${host}`);
    } catch {
      return undefined;
    }
    const path = SESSION_PATH.exec(url.pathname);
    if (!path) return undefined;
    if (request.method !== "GET" || url.search || url.hash) return new UpgradeRejection(404);
    const origin = request.headers.origin;
    if (!origin || !this.#origins.has(origin)) return new UpgradeRejection(403);
    const ticket = handshakeTicket(request.headers["sec-websocket-protocol"]);
    if (!ticket) return new UpgradeRejection(404);
    if (request.headers.upgrade?.toLowerCase() !== "websocket") return new UpgradeRejection(400);
    if (request.headers["sec-websocket-version"] !== "13") return new UpgradeRejection(400);
    return { sessionId: path[1]!, ticket };
  }
}

export class NodeWebSocketTakeoverPeer implements WebSocketTakeoverPeer {
  constructor(private readonly webSocket: WebSocket) {}

  sendControl(message: WebSocketTakeoverServerMessage): Promise<void> {
    return this.#send(JSON.stringify(message), false);
  }

  sendFrame(frame: WebSocketTakeoverFrame): Promise<void> {
    const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
    header.writeUInt32BE(FRAME_MAGIC, 0);
    header.writeUInt8(frame.mimeType === "image/jpeg" ? 1 : 2, 4);
    header.writeUInt8(0, 5);
    header.writeUInt16BE(frame.width, 6);
    header.writeUInt16BE(frame.height, 8);
    header.writeUInt32BE(frame.data.byteLength, 10);
    header.writeUInt16BE(0, 14);
    return this.#send(Buffer.concat([header, Buffer.from(frame.data)]), true);
  }

  bufferedAmount(): number {
    return this.webSocket.bufferedAmount;
  }

  close(code: number, reason: string): Promise<void> {
    if (this.webSocket.readyState === WebSocket.CLOSED) return Promise.resolve();
    if (this.webSocket.readyState === WebSocket.CONNECTING) {
      this.webSocket.terminate();
      return Promise.resolve();
    }
    try {
      this.webSocket.close(code, reason);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  #send(data: string | Buffer, binary: boolean): Promise<void> {
    if (this.webSocket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("WebSocket peer is not open"));
    }
    return new Promise<void>((resolve, reject) => {
      this.webSocket.send(data, { binary }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}


function bootstrapJson(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      pragma: "no-cache",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff"
    }
  });
}

function handshakeTicket(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const protocols = value.split(",").map((protocol) => protocol.trim()).filter(Boolean);
  if (protocols.length !== 2 || protocols[0] !== HANDOFF_SUBPROTOCOL) return undefined;
  const ticketPattern = new RegExp(
    `^${HANDSHAKE_PROTOCOL_PREFIX.replace(".", "\\.")}([A-Za-z0-9_-]{32,128})$`
  );
  const match = ticketPattern.exec(protocols[1]!);
  return match?.[1];
}

function normalizeAllowedOrigins(values: readonly string[]): ReadonlySet<string> {
  if (values.length < 1 || values.length > 32) {
    throw new Error("WebSocket Origin allowlist must contain between 1 and 32 origins");
  }
  const origins = new Set<string>();
  for (const value of values) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("WebSocket Origin allowlist requires exact HTTPS origins");
    }
    if (
      url.protocol !== "https:" ||
      url.origin !== value ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("WebSocket Origin allowlist requires exact HTTPS origins");
    }
    origins.add(url.origin);
  }
  return origins;
}

function boundedInboundLimit(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_INBOUND_BYTES;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > ABSOLUTE_MAX_INBOUND_BYTES) {
    throw new Error(`maxInboundBytes must be an integer between 1 and ${ABSOLUTE_MAX_INBOUND_BYTES}`);
  }
  return resolved;
}

function validateInputPolicy(value: WebSocketTakeoverInputPolicy): void {
  const keys = ["tap", "scroll", "text", "key"] as const;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key as typeof keys[number])) ||
    keys.some((key) => typeof value[key] !== "boolean")
  ) {
    throw new Error("WebSocket takeover requires an exact input policy");
  }
}

function sameInputPolicy(
  left: WebSocketTakeoverInputPolicy,
  right: WebSocketTakeoverInputPolicy
): boolean {
  return left.tap === right.tap
    && left.scroll === right.scroll
    && left.text === right.text
    && left.key === right.key;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function rawDataByteLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((sum, part) => sum + part.byteLength, 0);
  return data.byteLength;
}

function rawDataToUtf8(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(new Uint8Array(data)).toString("utf8");
}

function rejectUpgrade(socket: Duplex, statusCode: number): void {
  const reason = statusCode === 403
    ? "Forbidden"
    : statusCode === 409
      ? "Conflict"
      : statusCode === 500
        ? "Internal Server Error"
        : statusCode === 400
          ? "Bad Request"
          : "Not Found";
  try {
    socket.write(
      `HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`
    );
  } finally {
    socket.destroy();
  }
}

class UpgradeRejection {
  constructor(readonly statusCode: number) {}
}
