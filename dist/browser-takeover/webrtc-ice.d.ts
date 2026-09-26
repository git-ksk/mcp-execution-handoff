export interface WebRtcTakeoverRuntimeBinding {
    takeoverSessionId: string;
    interventionId: string;
    epoch: number;
    principalBinding: string;
    clientBinding: string;
    clientGeneration: number;
    expiresAt: number;
    targetProcessId?: number;
    targetWindowId?: number;
}
export interface WebRtcIceServer {
    urls: string | string[];
    username?: string;
    credential?: string;
}
export type WebRtcRelayAvailability = "disabled" | "available" | "unavailable";
export interface WebRtcBrowserIceConfiguration {
    iceServers: WebRtcIceServer[];
    relay: WebRtcRelayAvailability;
}
export interface WebRtcPreparedIceSession {
    readonly browser: WebRtcBrowserIceConfiguration;
    readonly serverIceServers: WebRtcIceServer[];
    revoke(): Promise<void>;
}
export interface WebRtcIceCredentialProvider {
    issue(binding: WebRtcTakeoverRuntimeBinding): Promise<WebRtcPreparedIceSession>;
}
export type WebRtcRelayCredentialFailureReason = "generation_expired" | "provider_auth" | "provider_rate_limited" | "provider_rejected" | "provider_unavailable" | "response_invalid" | "unknown";
export declare class WebRtcRelayCredentialError extends Error {
    readonly reason: WebRtcRelayCredentialFailureReason;
    constructor(reason: WebRtcRelayCredentialFailureReason, message?: string);
}
export declare function relayCredentialFailureReason(error: unknown): WebRtcRelayCredentialFailureReason;
export interface CloudflareRealtimeTurnCredentialProviderConfig {
    /** Cloudflare Realtime TURN key identifier. Not a credential. */
    turnKeyId: string;
    /** Long-lived server-side TURN API token. Never serialize or expose this value. */
    turnKeyApiToken: string;
    fetchImpl?: typeof fetch;
    now?: () => number;
    maxCredentialTtlSeconds?: number;
}
export interface CoturnRestTurnCredentialProviderConfig {
    /** TURN/TURNS relay endpoints served by coturn. Credentials must not be embedded in the URLs. */
    turnUrls: string[];
    /** Optional STUN/STUNS endpoints. These do not carry credentials. */
    stunUrls?: string[];
    /** Server-side shared secret configured with coturn use-auth-secret/static-auth-secret. */
    sharedSecret: string;
    now?: () => number;
    randomId?: () => string;
}
export declare const WEBRTC_RELAY_ENV_NAMES: readonly ["MCP_HANDOFF_CLOUDFLARE_TURN_KEY_ID", "MCP_HANDOFF_CLOUDFLARE_TURN_KEY_API_TOKEN", "MCP_HANDOFF_COTURN_SHARED_SECRET", "MCP_HANDOFF_COTURN_TURN_URLS", "MCP_HANDOFF_COTURN_STUN_URLS"];
/**
 * Deployment-owned relay configuration is resolved only inside Handoff. Browser/Window/Terminal
 * consumers never select a provider or receive the long-lived relay credential material.
 */
export declare function webRtcIceCredentialProviderFromEnvironment(env: NodeJS.ProcessEnv): WebRtcIceCredentialProvider | undefined;
export declare function webRtcRelayEnvironmentConfigured(env?: NodeJS.ProcessEnv): boolean;
/**
 * Resolve the server-side direct discovery policy inside Handoff. The compatibility default keeps
 * the already-reviewed Cloudflare STUN endpoint, while deployments can explicitly replace it with
 * provider-neutral STUN/STUNS endpoints without changing any consumer API or relay provider.
 */
export declare function webRtcDirectDiscoveryIceServersFromEnvironment(env: NodeJS.ProcessEnv): WebRtcIceServer[];
/**
 * Cloudflare Realtime TURN adapter for the Handoff WebRTC transport.
 *
 * The long-lived key token stays in this server-side object. Each client generation receives two
 * independent short-lived allocations: one for the browser peer and one for the server peer. The
 * short-lived material exists only in memory / no-store signaling responses and is revoked with
 * the corresponding Handoff generation. No principal, intervention id, network identifier, or
 * custom TURN analytics identifier is sent to Cloudflare.
 */
export declare class CloudflareRealtimeTurnCredentialProvider implements WebRtcIceCredentialProvider {
    private readonly config;
    private readonly fetchImpl;
    private readonly now;
    private readonly maxTtlSeconds;
    constructor(config: CloudflareRealtimeTurnCredentialProviderConfig);
    issue(binding: WebRtcTakeoverRuntimeBinding): Promise<WebRtcPreparedIceSession>;
    private generate;
    private revokeUsernames;
    private headers;
}
export declare class CoturnRestTurnCredentialProvider implements WebRtcIceCredentialProvider {
    private readonly config;
    private readonly turnUrls;
    private readonly stunUrls;
    private readonly now;
    private readonly randomId;
    constructor(config: CoturnRestTurnCredentialProviderConfig);
    issue(binding: WebRtcTakeoverRuntimeBinding): Promise<WebRtcPreparedIceSession>;
    private issuePeerCredential;
    private peerIceServers;
}
export declare function directOnlyIceSession(relay?: WebRtcRelayAvailability, serverIceServers?: readonly WebRtcIceServer[]): WebRtcPreparedIceSession;
export declare function cloneIceServers(servers: readonly WebRtcIceServer[]): WebRtcIceServer[];
//# sourceMappingURL=webrtc-ice.d.ts.map