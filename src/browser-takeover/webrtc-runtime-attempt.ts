import {
  SpawnedWebRtcRuntimeProvider,
  type SpawnedWebRtcRuntimeProviderConfig
} from "./webrtc-runtime.js";

const RELAY_ENV_NAMES = [
  "MCP_HANDOFF_CLOUDFLARE_TURN_KEY_ID",
  "MCP_HANDOFF_CLOUDFLARE_TURN_KEY_API_TOKEN",
  "MCP_HANDOFF_COTURN_SHARED_SECRET",
  "MCP_HANDOFF_COTURN_TURN_URLS",
  "MCP_HANDOFF_COTURN_STUN_URLS"
] as const;

/**
 * Run one synchronous construction boundary without exposing configured relay environment to it.
 * The process environment is restored before control returns; callers must not perform async work
 * inside the factory.
 */
export function withDirectOnlyWebRtcEnvironment<T>(factory: () => T): T {
  const saved = new Map<string, string | undefined>(
    RELAY_ENV_NAMES.map((name) => [name, process.env[name]])
  );
  try {
    for (const name of RELAY_ENV_NAMES) delete process.env[name];
    return factory();
  } finally {
    for (const name of RELAY_ENV_NAMES) {
      const value = saved.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Returns whether relay-related deployment configuration is present at all. */
export function webRtcRelayEnvironmentConfigured(): boolean {
  return RELAY_ENV_NAMES.some((name) => Boolean(process.env[name]?.trim()));
}

/**
 * Construct the first WebRTC attempt without observing or issuing relay credentials.
 *
 * `SpawnedWebRtcRuntimeProvider` snapshots its relay credential provider synchronously in its
 * constructor. Handoff therefore masks only the relay-related environment for that synchronous
 * construction boundary and restores it before returning. There is no asynchronous gap where a
 * caller can observe the masked process environment.
 *
 * This is an internal staging seam for managed fallback. Browser/Window consumers never select
 * ICE/TURN providers or this mode directly.
 */
export function createDirectOnlyWebRtcRuntime(
  config: SpawnedWebRtcRuntimeProviderConfig
): SpawnedWebRtcRuntimeProvider {
  return withDirectOnlyWebRtcEnvironment(() => new SpawnedWebRtcRuntimeProvider(config));
}

/** Construct the optional final WebRTC attempt with normal Handoff-owned relay configuration. */
export function createRelayEnabledWebRtcRuntime(
  config: SpawnedWebRtcRuntimeProviderConfig
): SpawnedWebRtcRuntimeProvider {
  return new SpawnedWebRtcRuntimeProvider(config);
}
