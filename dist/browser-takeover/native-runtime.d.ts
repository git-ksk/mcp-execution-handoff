import { spawn } from "node:child_process";
import type { TakeoverGrant } from "./session.js";
export interface NativeTakeoverClientEndpoint {
    clientHost: string;
    videoPort: number;
    inputFeedbackPort: number;
}
export interface NativeTakeoverRuntimeBinding {
    takeoverSessionId: string;
    interventionId: string;
    epoch: number;
    principalBinding: string;
    clientGeneration: number;
    expiresAt: number;
    targetProcessId?: number;
    targetWindowId?: number;
}
export interface NativeTakeoverNetworkBootstrap {
    host: string;
    videoPort: number;
    inputPort: number;
    videoFeedbackPort: number;
    inputFeedbackPort: number;
}
/**
 * Ephemeral client bootstrap. `rootKeyBase64Url` is intentionally response-body-only material:
 * callers must keep it in memory, never place it in a URL/header/log/checkpoint, and discard it
 * after constructing the native client session.
 */
export interface NativeTakeoverClientBootstrap {
    rootKeyBase64Url: string;
    sessionHashHex: string;
    epoch: number;
    network: NativeTakeoverNetworkBootstrap;
}
export interface NativeTakeoverRuntimeProvider {
    begin(binding: NativeTakeoverRuntimeBinding, endpoint: NativeTakeoverClientEndpoint): Promise<NativeTakeoverClientBootstrap>;
    revoke(takeoverSessionId: string): Promise<void>;
    revokeForIntervention(interventionId: string): Promise<void>;
}
export declare class NativeTakeoverRuntimeError extends Error {
    readonly code: "NATIVE_ENDPOINT_INVALID" | "NATIVE_BOOTSTRAP_ALREADY_ISSUED" | "NATIVE_RUNTIME_START_FAILED" | "NATIVE_RUNTIME_REVOKE_FAILED";
    constructor(code: "NATIVE_ENDPOINT_INVALID" | "NATIVE_BOOTSTRAP_ALREADY_ISSUED" | "NATIVE_RUNTIME_START_FAILED" | "NATIVE_RUNTIME_REVOKE_FAILED", message: string);
}
export declare function parseNativeTakeoverClientEndpoint(value: unknown): NativeTakeoverClientEndpoint;
export declare function nativeBindingFromGrant(grant: TakeoverGrant, targetProcessId?: number, targetWindowId?: number): NativeTakeoverRuntimeBinding;
export interface InheritedFdNativeRuntimeProviderConfig {
    hostExecutable: string;
    revokeExecutable: string;
    advertisedHost: string;
    inputBindHost: string;
    feedbackBindHost: string;
    controlBindHost?: string;
    inputPort?: number;
    controlPort?: number;
    videoFeedbackPort?: number;
    displayId?: number;
    spawnProcess?: typeof spawn;
}
/**
 * Reference local-macOS launcher for the Thin Takeover Runtime.
 *
 * The transport root key is generated per TakeoverBroker client generation and is sent to the
 * macOS host through inherited FD 3. It never appears in argv, the child environment, or durable
 * provider state. The only retained copy is this process-local Buffer, which is zeroed on revoke.
 */
export declare class InheritedFdNativeRuntimeProvider implements NativeTakeoverRuntimeProvider {
    private readonly config;
    private readonly active;
    private readonly spawnProcess;
    private readonly inputPort;
    private readonly controlPort;
    private readonly videoFeedbackPort;
    constructor(config: InheritedFdNativeRuntimeProviderConfig);
    begin(binding: NativeTakeoverRuntimeBinding, endpoint: NativeTakeoverClientEndpoint): Promise<NativeTakeoverClientBootstrap>;
    revoke(takeoverSessionId: string): Promise<void>;
    revokeForIntervention(interventionId: string): Promise<void>;
    private sendAuthenticatedRevoke;
    private waitForSpawn;
    private waitForExitOrTerminate;
}
//# sourceMappingURL=native-runtime.d.ts.map