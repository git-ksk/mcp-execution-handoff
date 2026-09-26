export class HostedWorkerRegistryError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "HostedWorkerRegistryError";
    }
}
const REGISTRATION_KEYS = new Set(["workerId", "principalBinding", "channelBinding"]);
const ROUTE_KEYS = new Set(["interventionId", "epoch", "principalBinding", "workerId", "workerGeneration"]);
function boundedString(value, min, max) {
    return typeof value === "string"
        && value.length >= min
        && value.length <= max
        && !/[\0\r\n]/.test(value);
}
function exactKeys(value, allowed) {
    return Object.keys(value).every((key) => allowed.has(key));
}
function parseRegistrationRequest(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, REGISTRATION_KEYS)
        || !boundedString(value.workerId, 1, 160)
        || !boundedString(value.principalBinding, 16, 160)
        || !boundedString(value.channelBinding, 16, 160)) {
        throw new HostedWorkerRegistryError("HOSTED_WORKER_INVALID", "Invalid hosted worker registration");
    }
    return { workerId: value.workerId, principalBinding: value.principalBinding, channelBinding: value.channelBinding };
}
function parseRouteRequest(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, ROUTE_KEYS)
        || !boundedString(value.interventionId, 1, 160)
        || !Number.isSafeInteger(value.epoch) || value.epoch < 0
        || !boundedString(value.principalBinding, 16, 160)
        || !boundedString(value.workerId, 1, 160)
        || !Number.isSafeInteger(value.workerGeneration) || value.workerGeneration <= 0) {
        throw new HostedWorkerRegistryError("HOSTED_WORKER_INVALID", "Invalid hosted worker route");
    }
    return { ...value };
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
export class HostedWorkerRegistry {
    now;
    activeWorkers = new Map();
    workerPrincipals = new Map();
    workerGenerations = new Map();
    routes = new Map();
    constructor(now = Date.now) {
        this.now = now;
    }
    register(request) {
        const parsed = parseRegistrationRequest(request);
        const pinnedPrincipal = this.workerPrincipals.get(parsed.workerId);
        if (pinnedPrincipal !== undefined && pinnedPrincipal !== parsed.principalBinding) {
            throw new HostedWorkerRegistryError("HOSTED_WORKER_IDENTITY_CONFLICT", "Hosted worker identity is already bound to another principal");
        }
        const active = this.activeWorkers.get(parsed.workerId);
        if (active) {
            if (active.registration.principalBinding === parsed.principalBinding
                && active.channelBinding === parsed.channelBinding) {
                return { ...active.registration };
            }
            throw new HostedWorkerRegistryError("HOSTED_WORKER_ALREADY_CONNECTED", "Hosted worker already has an active authenticated channel");
        }
        const previousGeneration = this.workerGenerations.get(parsed.workerId) ?? 0;
        if (!Number.isSafeInteger(previousGeneration) || previousGeneration >= Number.MAX_SAFE_INTEGER) {
            throw new HostedWorkerRegistryError("HOSTED_WORKER_INVALID", "Hosted worker generation exhausted");
        }
        const generation = previousGeneration + 1;
        const registeredAt = this.now();
        if (!Number.isSafeInteger(registeredAt) || registeredAt < 0) {
            throw new HostedWorkerRegistryError("HOSTED_WORKER_INVALID", "Invalid hosted worker registration time");
        }
        const registration = {
            workerId: parsed.workerId,
            principalBinding: parsed.principalBinding,
            generation,
            registeredAt
        };
        this.workerPrincipals.set(parsed.workerId, parsed.principalBinding);
        this.workerGenerations.set(parsed.workerId, generation);
        this.activeWorkers.set(parsed.workerId, { registration, channelBinding: parsed.channelBinding });
        return { ...registration };
    }
    get(workerId) {
        if (!boundedString(workerId, 1, 160))
            return undefined;
        const active = this.activeWorkers.get(workerId);
        return active ? { ...active.registration } : undefined;
    }
    disconnect(workerId, generation, channelBinding) {
        const active = this.requireWorker(workerId);
        if (!Number.isSafeInteger(generation) || generation <= 0 || active.registration.generation !== generation) {
            throw new HostedWorkerRegistryError("HOSTED_WORKER_STALE_GENERATION", "Hosted worker disconnect generation is stale");
        }
        if (!boundedString(channelBinding, 16, 160) || active.channelBinding !== channelBinding) {
            throw new HostedWorkerRegistryError("HOSTED_WORKER_STALE_GENERATION", "Hosted worker disconnect channel is stale");
        }
        this.activeWorkers.delete(workerId);
        const revoked = [];
        for (const route of this.routes.values()) {
            if (route.active && route.workerId === workerId && route.workerGeneration === generation) {
                route.active = false;
                revoked.push(this.publicRoute(route));
            }
        }
        return revoked;
    }
    bindIntervention(request) {
        const parsed = parseRouteRequest(request);
        const worker = this.requireWorker(parsed.workerId);
        if (worker.registration.generation !== parsed.workerGeneration) {
            throw new HostedWorkerRegistryError("HOSTED_WORKER_STALE_GENERATION", "Hosted worker route generation is stale");
        }
        if (worker.registration.principalBinding !== parsed.principalBinding) {
            throw new HostedWorkerRegistryError("HOSTED_WORKER_PRINCIPAL_MISMATCH", "Hosted worker route principal does not match authenticated worker");
        }
        const existing = this.routes.get(parsed.interventionId);
        if (existing) {
            if (existing.principalBinding !== parsed.principalBinding || existing.workerId !== parsed.workerId) {
                throw new HostedWorkerRegistryError("HOSTED_WORKER_ROUTE_CONFLICT", "Hosted worker route cannot move to another principal or worker identity");
            }
            if (existing.epoch > parsed.epoch) {
                throw new HostedWorkerRegistryError("HOSTED_WORKER_ROUTE_CONFLICT", "Hosted worker route epoch is stale");
            }
            if (existing.epoch === parsed.epoch && existing.active) {
                if (existing.workerGeneration !== parsed.workerGeneration) {
                    throw new HostedWorkerRegistryError("HOSTED_WORKER_ROUTE_CONFLICT", "Hosted worker route already has an active generation");
                }
                return this.publicRoute(existing);
            }
            existing.epoch = parsed.epoch;
            existing.workerGeneration = parsed.workerGeneration;
            existing.active = true;
            return this.publicRoute(existing);
        }
        const route = { ...parsed, active: true };
        this.routes.set(parsed.interventionId, route);
        return this.publicRoute(route);
    }
    assertCurrent(route) {
        const parsed = parseRouteRequest(route);
        const activeWorker = this.activeWorkers.get(parsed.workerId);
        const current = this.routes.get(parsed.interventionId);
        if (!activeWorker
            || activeWorker.registration.generation !== parsed.workerGeneration
            || activeWorker.registration.principalBinding !== parsed.principalBinding
            || !current
            || !current.active
            || current.epoch !== parsed.epoch
            || current.principalBinding !== parsed.principalBinding
            || current.workerId !== parsed.workerId
            || current.workerGeneration !== parsed.workerGeneration) {
            throw new HostedWorkerRegistryError("HOSTED_WORKER_STALE_GENERATION", "Hosted worker route is no longer current");
        }
    }
    releaseIntervention(route) {
        const parsed = parseRouteRequest(route);
        const current = this.routes.get(parsed.interventionId);
        if (!current || !current.active) {
            throw new HostedWorkerRegistryError("HOSTED_WORKER_ROUTE_NOT_FOUND", "Hosted worker route is not active");
        }
        if (current.epoch !== parsed.epoch
            || current.principalBinding !== parsed.principalBinding
            || current.workerId !== parsed.workerId
            || current.workerGeneration !== parsed.workerGeneration) {
            throw new HostedWorkerRegistryError("HOSTED_WORKER_STALE_GENERATION", "Hosted worker route release is stale");
        }
        current.active = false;
    }
    requireWorker(workerId) {
        if (!boundedString(workerId, 1, 160)) {
            throw new HostedWorkerRegistryError("HOSTED_WORKER_INVALID", "Invalid hosted worker identity");
        }
        const active = this.activeWorkers.get(workerId);
        if (!active) {
            throw new HostedWorkerRegistryError("HOSTED_WORKER_NOT_CONNECTED", "Hosted worker is not connected");
        }
        return active;
    }
    publicRoute(route) {
        return {
            interventionId: route.interventionId,
            epoch: route.epoch,
            principalBinding: route.principalBinding,
            workerId: route.workerId,
            workerGeneration: route.workerGeneration
        };
    }
}
//# sourceMappingURL=hosted-worker.js.map