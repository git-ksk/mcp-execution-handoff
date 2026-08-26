import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { TakeoverBroker, TakeoverInterventionRef } from "../browser-takeover/broker.js";
import { experimentalWebSocketBrokerPort } from "../browser-takeover/experimental-websocket-port.js";
import {
  ExperimentalWebSocketTakeoverIngress,
  ExperimentalWebSocketTakeoverSessionAuthority
} from "./websocket-ingress.js";
import type {
  WebSocketTakeoverBinding,
  WebSocketTakeoverFrame,
  WebSocketTakeoverHumanInput,
  WebSocketTakeoverInputPolicy
} from "./websocket-takeover.js";

const BOOTSTRAP_PATH = /^\/takeover\/api\/websocket-bootstrap\/([A-Za-z0-9-]{8,100})$/;

export interface ExperimentalWebSocketBrokerBindingOptions {
  allowedOrigins: readonly string[];
  onInput(
    binding: Readonly<WebSocketTakeoverBinding>,
    input: WebSocketTakeoverHumanInput
  ): void | Promise<void>;
  maxInboundBytes?: number;
}

/**
 * Experimental bridge that binds WSS to the exact TakeoverBroker session authority.
 *
 * This module is intentionally absent from package exports while #40 physical Acceptance is open.
 * Transport choice therefore stays an internal coordinator concern rather than a stable consumer
 * API. Native, WebRTC, legacy HTTP and WSS all fence through the same TakeoverSessionManager.
 */
export class ExperimentalWebSocketBrokerBinding {
  readonly #port;
  readonly #authority: ExperimentalWebSocketTakeoverSessionAuthority;
  readonly #ingress: ExperimentalWebSocketTakeoverIngress;
  readonly #policies = new Map<string, WebSocketTakeoverInputPolicy>();

  constructor(
    broker: TakeoverBroker,
    options: ExperimentalWebSocketBrokerBindingOptions
  ) {
    this.#port = experimentalWebSocketBrokerPort(broker);
    this.#authority = new ExperimentalWebSocketTakeoverSessionAuthority(
      this.#port.sessions,
      Date.now,
      undefined,
      undefined,
      {
        completed: async (completion) => {
          this.#policies.delete(completion.id);
          await this.#port.completeSession(completion);
        }
      }
    );
    this.#ingress = new ExperimentalWebSocketTakeoverIngress({
      authority: this.#authority,
      allowedOrigins: options.allowedOrigins,
      onInput: options.onInput,
      ...(options.maxInboundBytes === undefined ? {} : { maxInboundBytes: options.maxInboundBytes })
    });
  }

  createLink(
    intervention: TakeoverInterventionRef,
    principalBinding: string | undefined,
    inputPolicy: WebSocketTakeoverInputPolicy
  ): string | undefined {
    const policy = normalizeInputPolicy(inputPolicy);
    if (!policy) return undefined;
    const session = this.#port.createSession(intervention, principalBinding);
    if (!session) return undefined;
    const sessionId = session.locator.id;
    const existingPolicy = this.#policies.get(sessionId);
    if (existingPolicy) {
      return sameInputPolicy(existingPolicy, policy) ? session.url : undefined;
    }
    this.#policies.set(sessionId, policy);
    if (!this.#port.attachRevokeHandler(sessionId, async () => {
      this.#policies.delete(sessionId);
      await this.#ingress.revoke(sessionId);
    })) {
      this.#policies.delete(sessionId);
      this.#port.revokeSession(sessionId);
      return undefined;
    }
    return session.url;
  }

  handleBootstrap(
    request: Request,
    boundPrincipal: string | undefined
  ): Response | undefined {
    const url = new URL(request.url);
    const match = BOOTSTRAP_PATH.exec(url.pathname);
    if (!match) return undefined;
    const policy = this.#policies.get(match[1]!);
    if (!policy) {
      return new Response(JSON.stringify({ error: "takeover_unavailable" }), {
        status: 404,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store, max-age=0",
          pragma: "no-cache",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff"
        }
      });
    }
    return this.#ingress.handleBootstrap(request, boundPrincipal, policy);
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    return this.#ingress.handleUpgrade(request, socket, head);
  }

  hasActiveConnection(sessionId: string): boolean {
    return this.#ingress.hasActiveConnection(sessionId);
  }

  pushFrame(sessionId: string, frame: WebSocketTakeoverFrame): Promise<boolean> {
    return this.#ingress.pushFrame(sessionId, frame);
  }

  revoke(sessionId: string): void {
    this.#port.revokeSession(sessionId);
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

function normalizeInputPolicy(
  inputPolicy: WebSocketTakeoverInputPolicy
): WebSocketTakeoverInputPolicy | undefined {
  if (!inputPolicy || typeof inputPolicy !== "object" || Array.isArray(inputPolicy)) return undefined;
  const record = inputPolicy as unknown as Record<string, unknown>;
  const keys = ["tap", "scroll", "text", "key"] as const;
  if (Object.keys(record).length !== keys.length) return undefined;
  if (Object.keys(record).some((key) => !keys.includes(key as typeof keys[number]))) return undefined;
  if (keys.some((key) => typeof record[key] !== "boolean")) return undefined;
  return {
    tap: inputPolicy.tap,
    scroll: inputPolicy.scroll,
    text: inputPolicy.text,
    key: inputPolicy.key
  };
}
