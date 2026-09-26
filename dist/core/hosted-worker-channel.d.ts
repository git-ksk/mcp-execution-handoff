import { HostedWorkerRegistry, type HostedWorkerRegistration, type HostedWorkerRegistrationRequest, type HostedWorkerRouteLease, type HostedWorkerRouteRequest } from "./hosted-worker.js";
export declare const HOSTED_WORKER_CONTROL_PROTOCOL_VERSION: 1;
export type HostedWorkerControlMessage = {
    version: typeof HOSTED_WORKER_CONTROL_PROTOCOL_VERSION;
    type: "registered";
    workerGeneration: number;
} | {
    version: typeof HOSTED_WORKER_CONTROL_PROTOCOL_VERSION;
    type: "bind";
    interventionId: string;
    epoch: number;
    workerGeneration: number;
} | {
    version: typeof HOSTED_WORKER_CONTROL_PROTOCOL_VERSION;
    type: "revoke";
    interventionId: string;
    epoch: number;
    workerGeneration: number;
};
export interface HostedWorkerControlPeer {
    send(message: Readonly<HostedWorkerControlMessage>): void | Promise<void>;
    close?(): void | Promise<void>;
}
export type HostedWorkerRouteInvalidationReason = "bind_delivery_failure" | "explicit_revoke" | "revoke_delivery_failure" | "worker_disconnect";
export interface HostedWorkerControlChannelHooks {
    routesInvalidated?(routes: readonly Readonly<HostedWorkerRouteLease>[], reason: HostedWorkerRouteInvalidationReason): void | Promise<void>;
}
export declare class HostedWorkerControlChannelError extends Error {
    readonly code: "HOSTED_WORKER_CHANNEL_UNAVAILABLE" | "HOSTED_WORKER_CHANNEL_CLOSED" | "HOSTED_WORKER_REVOCATION_PROPAGATION_FAILED";
    constructor(code: "HOSTED_WORKER_CHANNEL_UNAVAILABLE" | "HOSTED_WORKER_CHANNEL_CLOSED" | "HOSTED_WORKER_REVOCATION_PROPAGATION_FAILED", message: string);
}
/**
 * Provider-neutral control-plane side of an authenticated outbound worker channel.
 *
 * The deployment transport authenticates the worker first and supplies a trusted
 * HostedWorkerRegistrationRequest. No worker/principal identity is accepted from peer messages.
 * This class owns only bounded control messages; frame data, Human input and credentials are not
 * part of this protocol.
 */
export declare class HostedWorkerControlChannel {
    #private;
    private readonly registry;
    private readonly peer;
    private readonly hooks;
    private constructor();
    static open(registry: HostedWorkerRegistry, authenticated: HostedWorkerRegistrationRequest, peer: HostedWorkerControlPeer, hooks?: HostedWorkerControlChannelHooks): Promise<HostedWorkerControlChannel>;
    registration(): HostedWorkerRegistration;
    bindIntervention(request: Omit<HostedWorkerRouteRequest, "workerId" | "workerGeneration">): Promise<HostedWorkerRouteLease>;
    assertCurrent(route: HostedWorkerRouteLease): void;
    revokeIntervention(route: HostedWorkerRouteLease): Promise<void>;
    disconnect(): Promise<HostedWorkerRouteLease[]>;
}
//# sourceMappingURL=hosted-worker-channel.d.ts.map