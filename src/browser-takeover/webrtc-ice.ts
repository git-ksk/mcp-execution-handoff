import { createHmac, randomBytes } from "node:crypto";

export interface WebRtcTakeoverRuntimeBinding {
  takeoverSessionId: string;
  interventionId: string;
  epoch: number;
  principalBinding: string;
  clientBinding: string;
  clientGeneration: number;
  expiresAt: number;
  targetProcessId?: number;
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

const CLOUDFLARE_TURN_ORIGIN = "https://rtc.live.cloudflare.com";
const CLOUDFLARE_STUN_URL = "stun:stun.cloudflare.com:3478";
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

export class CoturnRestTurnCredentialProvider implements WebRtcIceCredentialProvider {
  private readonly turnUrls: string[];
  private readonly stunUrls: string[];
  private readonly now: () => number;
  private readonly randomId: () => string;

  constructor(private readonly config: CoturnRestTurnCredentialProviderConfig) {
    this.turnUrls = parseConfiguredIceUrls(config.turnUrls, "turn");
    this.stunUrls = parseConfiguredIceUrls(config.stunUrls ?? [], "stun", true);
    if (
      typeof config.sharedSecret !== "string" ||
      Buffer.byteLength(config.sharedSecret, "utf8") < 32 ||
      Buffer.byteLength(config.sharedSecret, "utf8") > MAX_ICE_CREDENTIAL_BYTES ||
      /\s/.test(config.sharedSecret)
    ) {
      throw new Error("coturn shared secret is invalid");
    }
    this.now = config.now ?? Date.now;
    this.randomId = config.randomId ?? (() => randomBytes(18).toString("base64url"));
  }

  async issue(binding: WebRtcTakeoverRuntimeBinding): Promise<WebRtcPreparedIceSession> {
    const now = this.now();
    const remainingMs = binding.expiresAt - now;
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      throw new Error("WebRTC generation is expired");
    }
    const expiresAtSeconds = Math.ceil(binding.expiresAt / 1_000);
    const browser = this.issuePeerCredential(expiresAtSeconds);
    const server = this.issuePeerCredential(expiresAtSeconds);
    if (browser.username === server.username) {
      throw new Error("TURN credential issuance failed");
    }
    return {
      browser: {
        iceServers: this.peerIceServers(browser),
        relay: "available"
      },
      serverIceServers: this.peerIceServers(server),
      revoke: async () => {
        // coturn TURN REST credentials have no per-credential revoke API. Handoff revokes the
        // generation immediately; the randomized TURN credential remains usable only until the
        // same generation expiry encoded in its username.
      }
    };
  }

  private issuePeerCredential(expiresAtSeconds: number): { username: string; credential: string } {
    const id = this.randomId();
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(id)) {
      throw new Error("TURN credential issuance failed");
    }
    const username = `${expiresAtSeconds}:${id}`;
    const credential = createHmac("sha1", this.config.sharedSecret).update(username, "utf8").digest("base64");
    return { username, credential };
  }

  private peerIceServers(peer: { username: string; credential: string }): WebRtcIceServer[] {
    const servers: WebRtcIceServer[] = [];
    if (this.stunUrls.length > 0) {
      servers.push({ urls: this.stunUrls.length === 1 ? this.stunUrls[0]! : [...this.stunUrls] });
    }
    servers.push({
      urls: this.turnUrls.length === 1 ? this.turnUrls[0]! : [...this.turnUrls],
      username: peer.username,
      credential: peer.credential
    });
    return servers;
  }
}

export function directOnlyIceSession(relay: WebRtcRelayAvailability = "disabled"): WebRtcPreparedIceSession {
  return {
    // Keep the browser host-only: this client waits for ICE gathering rather than trickling, so a
    // browser-side STUN timeout would directly delay takeover startup. The server gets one explicit
    // STUN server to override werift's hidden third-party fallback while preserving direct-first
    // ICE and the same Cloudflare trust boundary used by the optional TURN fallback.
    browser: { iceServers: [], relay },
    serverIceServers: [{ urls: CLOUDFLARE_STUN_URL }],
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

function parseConfiguredIceUrls(values: readonly string[], kind: "turn" | "stun", allowEmpty = false): string[] {
  if (!Array.isArray(values) || (!allowEmpty && values.length < 1) || values.length > MAX_ICE_URLS_PER_SERVER) {
    throw new Error(`coturn ${kind} URLs are invalid`);
  }
  const urls: string[] = [];
  for (const raw of values) {
    if (
      typeof raw !== "string" || raw.length < 1 || Buffer.byteLength(raw, "utf8") > MAX_ICE_URL_BYTES ||
      !isConfiguredIceUrl(raw, kind)
    ) {
      throw new Error(`coturn ${kind} URLs are invalid`);
    }
    urls.push(raw);
  }
  return urls;
}

function isConfiguredIceUrl(raw: string, kind: "turn" | "stun"): boolean {
  if (/\s|@|#|\//.test(raw)) return false;
  const scheme = kind === "turn" ? /^(turns?):/i : /^(stuns?):/i;
  const match = scheme.exec(raw);
  if (!match) return false;
  let endpoint = raw.slice(match[0].length);
  const queryIndex = endpoint.indexOf("?");
  if (queryIndex >= 0) {
    if (kind !== "turn" || !/^transport=(?:udp|tcp)$/i.test(endpoint.slice(queryIndex + 1))) return false;
    endpoint = endpoint.slice(0, queryIndex);
  }
  if (!endpoint) return false;

  let host = endpoint;
  let port: string | undefined;
  if (endpoint.startsWith("[")) {
    const close = endpoint.indexOf("]");
    if (close <= 1 || !/^[0-9A-Fa-f:.]+$/.test(endpoint.slice(1, close))) return false;
    const suffix = endpoint.slice(close + 1);
    if (suffix) {
      if (!suffix.startsWith(":")) return false;
      port = suffix.slice(1);
    }
    host = endpoint.slice(0, close + 1);
  } else {
    const firstColon = endpoint.indexOf(":");
    const lastColon = endpoint.lastIndexOf(":");
    if (firstColon !== lastColon) return false;
    if (lastColon >= 0) {
      host = endpoint.slice(0, lastColon);
      port = endpoint.slice(lastColon + 1);
    }
    if (!/^[A-Za-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".")) return false;
  }
  if (!host) return false;
  if (port !== undefined) {
    if (!/^[0-9]{1,5}$/.test(port)) return false;
    const numericPort = Number(port);
    if (numericPort < 1 || numericPort > 65_535) return false;
  }
  return true;
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
