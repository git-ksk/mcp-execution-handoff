export interface WebRtcTakeoverRuntimeBinding {
  takeoverSessionId: string;
  interventionId: string;
  epoch: number;
  principalBinding: string;
  clientBinding: string;
  clientGeneration: number;
  expiresAt: number;
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

const CLOUDFLARE_TURN_ORIGIN = "https://rtc.live.cloudflare.com";
const MAX_TURN_CREDENTIAL_TTL_SECONDS = 48 * 60 * 60;
const MAX_ICE_SERVERS = 16;
const MAX_ICE_URLS_PER_SERVER = 16;
const MAX_ICE_URL_BYTES = 512;
const MAX_ICE_CREDENTIAL_BYTES = 2_048;
const MAX_ICE_RESPONSE_BYTES = 32 * 1024;

interface IssuedCloudflareIceServers {
  iceServers: WebRtcIceServer[];
  turnUsernames: string[];
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
export class CloudflareRealtimeTurnCredentialProvider implements WebRtcIceCredentialProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly maxTtlSeconds: number;

  constructor(private readonly config: CloudflareRealtimeTurnCredentialProviderConfig) {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(config.turnKeyId)) {
      throw new Error("Cloudflare TURN key id is invalid");
    }
    if (typeof config.turnKeyApiToken !== "string" || config.turnKeyApiToken.length < 8) {
      throw new Error("Cloudflare TURN server credential is invalid");
    }
    const configuredTtl = config.maxCredentialTtlSeconds ?? MAX_TURN_CREDENTIAL_TTL_SECONDS;
    if (!Number.isInteger(configuredTtl) || configuredTtl < 1 || configuredTtl > MAX_TURN_CREDENTIAL_TTL_SECONDS) {
      throw new Error("Cloudflare TURN credential TTL is invalid");
    }
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? Date.now;
    this.maxTtlSeconds = configuredTtl;
  }

  async issue(binding: WebRtcTakeoverRuntimeBinding): Promise<WebRtcPreparedIceSession> {
    const remainingMs = binding.expiresAt - this.now();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      throw new Error("WebRTC generation is expired");
    }
    const ttl = Math.max(1, Math.min(this.maxTtlSeconds, Math.ceil(remainingMs / 1_000)));
    let browser: IssuedCloudflareIceServers | undefined;
    let server: IssuedCloudflareIceServers | undefined;
    try {
      browser = await this.generate(ttl);
      server = await this.generate(ttl);
    } catch {
      if (browser) await this.revokeUsernames(browser.turnUsernames).catch(() => undefined);
      if (server) await this.revokeUsernames(server.turnUsernames).catch(() => undefined);
      throw new Error("TURN credential issuance failed");
    }

    const usernames = [...new Set([...browser.turnUsernames, ...server.turnUsernames])];
    let revoked = false;
    return {
      browser: {
        // Cloudflare documents port 53 as commonly blocked by browsers. This client waits for ICE
        // gathering rather than trickling, so omit those alternate URLs to avoid avoidable WAN
        // startup stalls while retaining UDP 3478, TCP 3478/80 and TLS 5349/443.
        iceServers: filterCloudflareBrowserIceServers(browser.iceServers),
        relay: "available"
      },
      serverIceServers: cloneIceServers(server.iceServers),
      revoke: async () => {
        if (revoked) return;
        revoked = true;
        await this.revokeUsernames(usernames);
      }
    };
  }

  private async generate(ttl: number): Promise<IssuedCloudflareIceServers> {
    const response = await this.fetchImpl(
      `${CLOUDFLARE_TURN_ORIGIN}/v1/turn/keys/${encodeURIComponent(this.config.turnKeyId)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ ttl }),
        cache: "no-store"
      }
    );
    if (!response.ok) throw new Error("TURN credential issuance failed");
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_ICE_RESPONSE_BYTES) {
      throw new Error("TURN credential response is invalid");
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_ICE_RESPONSE_BYTES) {
      throw new Error("TURN credential response is invalid");
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error("TURN credential response is invalid");
    }
    return parseCloudflareIceServers(value);
  }

  private async revokeUsernames(usernames: readonly string[]): Promise<void> {
    let failed = false;
    for (const username of usernames) {
      try {
        const response = await this.fetchImpl(
          `${CLOUDFLARE_TURN_ORIGIN}/v1/turn/keys/${encodeURIComponent(this.config.turnKeyId)}/credentials/${encodeURIComponent(username)}/revoke`,
          { method: "POST", headers: this.headers(), cache: "no-store" }
        );
        if (!response.ok) failed = true;
      } catch {
        failed = true;
      }
    }
    if (failed) throw new Error("TURN credential revoke failed");
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.config.turnKeyApiToken}`,
      "content-type": "application/json"
    };
  }
}

export function directOnlyIceSession(relay: WebRtcRelayAvailability = "disabled"): WebRtcPreparedIceSession {
  return {
    browser: { iceServers: [], relay },
    serverIceServers: [],
    async revoke() {}
  };
}

function filterCloudflareBrowserIceServers(servers: readonly WebRtcIceServer[]): WebRtcIceServer[] {
  const filtered: WebRtcIceServer[] = [];
  for (const server of servers) {
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((url) => {
      try {
        const withoutScheme = url.replace(/^[a-z]+:/i, "");
        const authority = withoutScheme.split("?")[0]!;
        return !authority.endsWith(":53");
      } catch {
        return false;
      }
    });
    if (urls.length === 0) continue;
    filtered.push({
      urls: urls.length === 1 ? urls[0]! : urls,
      ...(server.username !== undefined ? { username: server.username } : {}),
      ...(server.credential !== undefined ? { credential: server.credential } : {})
    });
  }
  return filtered;
}

export function cloneIceServers(servers: readonly WebRtcIceServer[]): WebRtcIceServer[] {
  return servers.map((server) => ({
    urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
    ...(server.username !== undefined ? { username: server.username } : {}),
    ...(server.credential !== undefined ? { credential: server.credential } : {})
  }));
}

function parseCloudflareIceServers(value: unknown): IssuedCloudflareIceServers {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("TURN credential response is invalid");
  }
  const raw = (value as Record<string, unknown>).iceServers;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ICE_SERVERS) {
    throw new Error("TURN credential response is invalid");
  }

  const iceServers: WebRtcIceServer[] = [];
  const turnUsernames = new Set<string>();
  let hasTurn = false;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("TURN credential response is invalid");
    }
    const record = entry as Record<string, unknown>;
    const urls = parseIceUrls(record.urls);
    const includesTurn = urls.some((url) => /^turns?:/i.test(url));
    const username = record.username;
    const credential = record.credential;
    if (includesTurn) {
      if (
        typeof username !== "string" || username.length < 1 || Buffer.byteLength(username, "utf8") > MAX_ICE_CREDENTIAL_BYTES ||
        typeof credential !== "string" || credential.length < 1 || Buffer.byteLength(credential, "utf8") > MAX_ICE_CREDENTIAL_BYTES
      ) {
        throw new Error("TURN credential response is invalid");
      }
      turnUsernames.add(username);
      hasTurn = true;
      iceServers.push({ urls: urls.length === 1 ? urls[0]! : urls, username, credential });
    } else {
      iceServers.push({ urls: urls.length === 1 ? urls[0]! : urls });
    }
  }
  if (!hasTurn || turnUsernames.size === 0) throw new Error("TURN credential response is invalid");
  return { iceServers, turnUsernames: [...turnUsernames] };
}

function parseIceUrls(value: unknown): string[] {
  const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : undefined;
  if (!values || values.length < 1 || values.length > MAX_ICE_URLS_PER_SERVER) {
    throw new Error("TURN credential response is invalid");
  }
  const urls: string[] = [];
  for (const raw of values) {
    if (typeof raw !== "string" || raw.length < 1 || Buffer.byteLength(raw, "utf8") > MAX_ICE_URL_BYTES) {
      throw new Error("TURN credential response is invalid");
    }
    if (!/^(?:stun|stuns|turn|turns):[^\s]+$/i.test(raw)) {
      throw new Error("TURN credential response is invalid");
    }
    urls.push(raw);
  }
  return urls;
}
