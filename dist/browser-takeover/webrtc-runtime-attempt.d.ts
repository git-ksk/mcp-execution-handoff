import { SpawnedWebRtcRuntimeProvider, type SpawnedWebRtcRuntimeProviderConfig } from "./webrtc-runtime.js";
/**
 * Run one synchronous construction boundary without exposing configured relay environment to it.
 * The process environment is restored before control returns; callers must not perform async work
 * inside the factory.
 */
export declare function withDirectOnlyWebRtcEnvironment<T>(factory: () => T): T;
/** Returns whether relay-related deployment configuration is present at all. */
export declare function webRtcRelayEnvironmentConfigured(): boolean;
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
export declare function createDirectOnlyWebRtcRuntime(config: SpawnedWebRtcRuntimeProviderConfig): SpawnedWebRtcRuntimeProvider;
/** Construct the optional final WebRTC attempt with normal Handoff-owned relay configuration. */
export declare function createRelayEnabledWebRtcRuntime(config: SpawnedWebRtcRuntimeProviderConfig): SpawnedWebRtcRuntimeProvider;
//# sourceMappingURL=webrtc-runtime-attempt.d.ts.map