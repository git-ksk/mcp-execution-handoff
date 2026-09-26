import { WEBRTC_RELAY_ENV_NAMES, webRtcRelayEnvironmentConfigured as relayEnvironmentConfigured } from "./webrtc-ice.js";
import { SpawnedWebRtcRuntimeProvider } from "./webrtc-runtime.js";
/**
 * Run one synchronous construction boundary without exposing configured relay environment to it.
 * The process environment is restored before control returns; callers must not perform async work
 * inside the factory.
 */
export function withDirectOnlyWebRtcEnvironment(factory) {
    const saved = new Map(WEBRTC_RELAY_ENV_NAMES.map((name) => [name, process.env[name]]));
    try {
        for (const name of WEBRTC_RELAY_ENV_NAMES)
            delete process.env[name];
        return factory();
    }
    finally {
        for (const name of WEBRTC_RELAY_ENV_NAMES) {
            const value = saved.get(name);
            if (value === undefined)
                delete process.env[name];
            else
                process.env[name] = value;
        }
    }
}
/** Returns whether relay-related deployment configuration is present at all. */
export function webRtcRelayEnvironmentConfigured() {
    return relayEnvironmentConfigured(process.env);
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
export function createDirectOnlyWebRtcRuntime(config) {
    return withDirectOnlyWebRtcEnvironment(() => new SpawnedWebRtcRuntimeProvider(config));
}
/** Construct the optional final WebRTC attempt with normal Handoff-owned relay configuration. */
export function createRelayEnabledWebRtcRuntime(config) {
    return new SpawnedWebRtcRuntimeProvider(config);
}
//# sourceMappingURL=webrtc-runtime-attempt.js.map