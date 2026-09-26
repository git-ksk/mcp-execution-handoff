export type HostedWorkerRegistryErrorCode = "HOSTED_WORKER_INVALID" | "HOSTED_WORKER_IDENTITY_CONFLICT" | "HOSTED_WORKER_ALREADY_CONNECTED" | "HOSTED_WORKER_NOT_CONNECTED" | "HOSTED_WORKER_STALE_GENERATION" | "HOSTED_WORKER_PRINCIPAL_MISMATCH" | "HOSTED_WORKER_ROUTE_CONFLICT" | "HOSTED_WORKER_ROUTE_NOT_FOUND";
export declare class HostedWorkerRegistryError extends Error {
    readonly code: HostedWorkerRegistryErrorCode;
    constructor(code: HostedWorkerRegistryErrorCode, message: string);
}
/**
 * An authenticated channel binding is an opaque digest/reference supplied by the deployment
 * transport after worker authentication. It is not a bearer credential and is never returned by
 * the registry or admitted to durable route metadata.
 */
export interface HostedWorkerRegistrationRequest {
    workerId: string;
    principalBinding: string;
    channelBinding: string;
}
export interface HostedWorkerRegistration {
    workerId: string;
    principalBinding: string;
    generation: number;
    registeredAt: number;
}
export interface HostedWorkerRouteRequest {
    interventionId: string;
    epoch: number;
    principalBinding: string;
    workerId: string;
    workerGeneration: number;
}
export interface HostedWorkerRouteLease {
    interventionId: string;
    epoch: number;
    principalBinding: string;
    workerId: string;
    workerGeneration: number;
}
/**
 * Process-local reference registry for the hosted control-plane / execution-worker boundary.
 *
 * Authentication itself belongs to the deployment transport. The registry accepts only the
 * resulting opaque channel binding and then owns worker generation fencing and intervention
 * routing. No frame, Human input, credential, cookie, browser/application content, target identity,
 * or bearer token is part of this contract.
 *
 * A worker identity is principal-bound for the registry lifetime. Reconnect is allowed only after
 * the current channel is disconnected and increments the worker generation. An intervention may
 * reconnect at the same epoch only to the same worker identity; moving it to another worker
 * requires a strictly newer intervention epoch.
 */
export declare class HostedWorkerRegistry {
    private readonly now;
    private readonly activeWorkers;
    private readonly workerPrincipals;
    private readonly workerGenerations;
    private readonly routes;
    constructor(now?: () => number);
    register(request: HostedWorkerRegistrationRequest): HostedWorkerRegistration;
    get(workerId: string): HostedWorkerRegistration | undefined;
    disconnect(workerId: string, generation: number, channelBinding: string): HostedWorkerRouteLease[];
    bindIntervention(request: HostedWorkerRouteRequest): HostedWorkerRouteLease;
    assertCurrent(route: HostedWorkerRouteLease): void;
    releaseIntervention(route: HostedWorkerRouteLease): void;
    private requireWorker;
    private publicRoute;
}
//# sourceMappingURL=hosted-worker.d.ts.map