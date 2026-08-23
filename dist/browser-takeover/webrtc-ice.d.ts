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
export declare function directOnlyIceSession(relay?: WebRtcRelayAvailability): WebRtcPreparedIceSession;
export declare function cloneIceServers(servers: readonly WebRtcIceServer[]): WebRtcIceServer[];
//# sourceMappingURL=webrtc-ice.d.ts.map