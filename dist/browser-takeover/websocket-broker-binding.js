import { experimentalWebSocketBrokerPort } from "../browser-takeover/experimental-websocket-port.js";
import { ExperimentalWebSocketTakeoverIngress, ExperimentalWebSocketTakeoverSessionAuthority } from "./websocket-ingress.js";
const BOOTSTRAP_PATH = /^\/takeover\/api\/websocket-bootstrap\/([A-Za-z0-9-]{8,100})$/;
/**
 * Experimental bridge that binds WSS to the exact TakeoverBroker session authority.
 *
 * This module is intentionally absent from package exports while #40 physical Acceptance is open.
 * Transport choice therefore stays an internal coordinator concern rather than a stable consumer
 * API. Native, WebRTC, legacy HTTP and WSS all fence through the same TakeoverSessionManager.
 */
export class ExperimentalWebSocketBrokerBinding {
    #port;
    #authority;
    #ingress;
    #policies = new Map();
    constructor(broker, options) {
        this.#port = experimentalWebSocketBrokerPort(broker);
        this.#authority = new ExperimentalWebSocketTakeoverSessionAuthority(this.#port.sessions, Date.now, undefined, undefined, {
            completed: async (completion) => {
                this.#policies.delete(completion.id);
                await this.#port.completeSession(completion);
            }
        });
        this.#ingress = new ExperimentalWebSocketTakeoverIngress({
            authority: this.#authority,
            allowedOrigins: options.allowedOrigins,
            onInput: options.onInput,
            ...(options.maxInboundBytes === undefined ? {} : { maxInboundBytes: options.maxInboundBytes }),
            ...(options.onDiagnosticEvent ? { onDiagnosticEvent: options.onDiagnosticEvent } : {})
        });
    }
    createLink(intervention, principalBinding, inputPolicy) {
        const policy = normalizeInputPolicy(inputPolicy);
        if (!policy)
            return undefined;
        const session = this.#port.createSession(intervention, principalBinding);
        if (!session)
            return undefined;
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
    validateLocator(sessionId, boundPrincipal) {
        if (!boundPrincipal || !this.#policies.has(sessionId))
            return false;
        try {
            this.#port.sessions.validateLocator(sessionId, boundPrincipal);
            return true;
        }
        catch {
            return false;
        }
    }
    handleBootstrap(request, boundPrincipal) {
        const url = new URL(request.url);
        const match = BOOTSTRAP_PATH.exec(url.pathname);
        if (!match)
            return undefined;
        const policy = this.#policies.get(match[1]);
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
    handleUpgrade(request, socket, head) {
        return this.#ingress.handleUpgrade(request, socket, head);
    }
    hasActiveConnection(sessionId) {
        return this.#ingress.hasActiveConnection(sessionId);
    }
    /** @internal Content-free WSS ingress diagnostics for managed physical acceptance. */
    diagnosticsSnapshot() {
        return this.#ingress.diagnosticsSnapshot();
    }
    pushFrame(sessionId, frame) {
        return this.#ingress.pushFrame(sessionId, frame);
    }
    revoke(sessionId) {
        this.#port.revokeSession(sessionId);
    }
}
function sameInputPolicy(left, right) {
    return left.tap === right.tap
        && left.scroll === right.scroll
        && left.text === right.text
        && left.key === right.key;
}
function normalizeInputPolicy(inputPolicy) {
    if (!inputPolicy || typeof inputPolicy !== "object" || Array.isArray(inputPolicy))
        return undefined;
    const record = inputPolicy;
    const keys = ["tap", "scroll", "text", "key"];
    if (Object.keys(record).length !== keys.length)
        return undefined;
    if (Object.keys(record).some((key) => !keys.includes(key)))
        return undefined;
    if (keys.some((key) => typeof record[key] !== "boolean"))
        return undefined;
    return {
        tap: inputPolicy.tap,
        scroll: inputPolicy.scroll,
        text: inputPolicy.text,
        key: inputPolicy.key
    };
}
//# sourceMappingURL=websocket-broker-binding.js.map