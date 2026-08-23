import { SpawnedWebRtcRuntimeProvider as BaseSpawnedWebRtcRuntimeProvider, type SpawnedWebRtcRuntimeProviderConfig } from "./webrtc-runtime.js";
export * from "./webrtc-runtime.js";
/**
 * Public WebRTC runtime provider with a privacy-preserving observer around the helper process.
 *
 * The base runtime remains the sole owner of peer/media/input lifecycle. This subclass only wraps
 * the already-configurable spawn seam so an unexpected helper exit can be attributed without
 * logging raw stderr, SDP, candidate addresses, media, Human input, process targets, or secrets.
 */
export declare class SpawnedWebRtcRuntimeProvider extends BaseSpawnedWebRtcRuntimeProvider {
    constructor(config: SpawnedWebRtcRuntimeProviderConfig);
}
//# sourceMappingURL=webrtc-runtime-diagnostics.d.ts.map