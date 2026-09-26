import { HostedWorkerRegistryError } from "./hosted-worker.js";
export const HOSTED_WORKER_CONTROL_PROTOCOL_VERSION = 1;
export class HostedWorkerControlChannelError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "HostedWorkerControlChannelError";
    }
}
/**
 * Provider-neutral control-plane side of an authenticated outbound worker channel.
 *
 * The deployment transport authenticates the worker first and supplies a trusted
 * HostedWorkerRegistrationRequest. No worker/principal identity is accepted from peer messages.
 * This class owns only bounded control messages; frame data, Human input and credentials are not
 * part of this protocol.
 */
export class HostedWorkerControlChannel {
    registry;
    peer;
    #registration;
    #channelBinding;
    #closed = false;
    constructor(registry, authenticated, peer) {
        this.registry = registry;
        this.peer = peer;
        this.#channelBinding = authenticated.channelBinding;
        this.#registration = this.registry.register(authenticated);
    }
    static async open(registry, authenticated, peer) {
        const channel = new HostedWorkerControlChannel(registry, authenticated, peer);
        try {
            await peer.send({
                version: HOSTED_WORKER_CONTROL_PROTOCOL_VERSION,
                type: "registered",
                workerGeneration: channel.#registration.generation
            });
        }
        catch {
            channel.#fenceLocal();
            await channel.#closePeerBestEffort();
            throw new HostedWorkerControlChannelError("HOSTED_WORKER_CHANNEL_UNAVAILABLE", "Hosted worker control channel registration delivery failed");
        }
        return channel;
    }
    registration() {
        return { ...this.#registration };
    }
    async bindIntervention(request) {
        this.#assertOpen();
        const route = this.registry.bindIntervention({
            ...request,
            workerId: this.#registration.workerId,
            workerGeneration: this.#registration.generation
        });
        try {
            await this.peer.send({
                version: HOSTED_WORKER_CONTROL_PROTOCOL_VERSION,
                type: "bind",
                interventionId: route.interventionId,
                epoch: route.epoch,
                workerGeneration: route.workerGeneration
            });
        }
        catch {
            this.#fenceLocal();
            await this.#closePeerBestEffort();
            throw new HostedWorkerControlChannelError("HOSTED_WORKER_CHANNEL_UNAVAILABLE", "Hosted worker control bind delivery failed");
        }
        return route;
    }
    assertCurrent(route) {
        this.#assertOpen();
        this.registry.assertCurrent(route);
        if (route.workerId !== this.#registration.workerId
            || route.workerGeneration !== this.#registration.generation) {
            throw new HostedWorkerRegistryError("HOSTED_WORKER_STALE_GENERATION", "Hosted worker route does not belong to this channel");
        }
    }
    async revokeIntervention(route) {
        this.#assertOpen();
        this.assertCurrent(route);
        // Fence local delivery before attempting remote notification. A failed notification can never
        // leave the control plane believing that mutable routing authority still exists.
        this.registry.releaseIntervention(route);
        try {
            await this.peer.send({
                version: HOSTED_WORKER_CONTROL_PROTOCOL_VERSION,
                type: "revoke",
                interventionId: route.interventionId,
                epoch: route.epoch,
                workerGeneration: route.workerGeneration
            });
        }
        catch {
            this.#fenceLocal();
            await this.#closePeerBestEffort();
            throw new HostedWorkerControlChannelError("HOSTED_WORKER_CHANNEL_UNAVAILABLE", "Hosted worker control revoke delivery failed");
        }
    }
    async disconnect() {
        if (this.#closed)
            return [];
        const revoked = this.#fenceLocal();
        await this.#closePeerBestEffort();
        return revoked;
    }
    #fenceLocal() {
        if (this.#closed)
            return [];
        this.#closed = true;
        return this.registry.disconnect(this.#registration.workerId, this.#registration.generation, this.#channelBinding);
    }
    async #closePeerBestEffort() {
        try {
            await this.peer.close?.();
        }
        catch {
            // Local worker generation and every bound route are already fenced. Transport close failure
            // cannot restore authority and is intentionally not allowed to mask the stronger local state.
        }
    }
    #assertOpen() {
        if (this.#closed) {
            throw new HostedWorkerControlChannelError("HOSTED_WORKER_CHANNEL_CLOSED", "Hosted worker control channel is closed");
        }
    }
}
//# sourceMappingURL=hosted-worker-channel.js.map