import { assertHostedOperatorBindingCurrent } from "./hosted-operator-binding.js";
export const HOSTED_WORKER_DATA_PROTOCOL_VERSION = 1;
export class HostedHumanInputError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "HostedHumanInputError";
    }
}
const MAX_TEXT_BYTES = 4 * 1024;
const MAX_KEY_BYTES = 64;
const MAX_SCROLL_DELTA = 2_000;
function utf8Bytes(value) {
    return new TextEncoder().encode(value).byteLength;
}
function exactKeys(value, allowed) {
    const keys = Object.keys(value);
    return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}
export function parseHostedHumanInput(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new HostedHumanInputError("HOSTED_INPUT_INVALID", "Invalid hosted Human input");
    }
    const record = value;
    switch (record.kind) {
        case "tap":
            if (!exactKeys(record, ["kind", "x", "y"])
                || typeof record.x !== "number" || !Number.isFinite(record.x) || record.x < 0 || record.x > 1
                || typeof record.y !== "number" || !Number.isFinite(record.y) || record.y < 0 || record.y > 1) {
                throw new HostedHumanInputError("HOSTED_INPUT_INVALID", "Invalid hosted tap input");
            }
            return { kind: "tap", x: record.x, y: record.y };
        case "scroll":
            if (!exactKeys(record, ["kind", "deltaY"])
                || !Number.isInteger(record.deltaY)
                || Number(record.deltaY) < -MAX_SCROLL_DELTA
                || Number(record.deltaY) > MAX_SCROLL_DELTA) {
                throw new HostedHumanInputError("HOSTED_INPUT_INVALID", "Invalid hosted scroll input");
            }
            return { kind: "scroll", deltaY: record.deltaY };
        case "text":
            if (!exactKeys(record, ["kind", "text"])
                || typeof record.text !== "string"
                || utf8Bytes(record.text) > MAX_TEXT_BYTES) {
                throw new HostedHumanInputError("HOSTED_INPUT_INVALID", "Invalid hosted text input");
            }
            return { kind: "text", text: record.text };
        case "key":
            if (!exactKeys(record, ["kind", "key"])
                || typeof record.key !== "string"
                || record.key.length === 0
                || utf8Bytes(record.key) > MAX_KEY_BYTES) {
                throw new HostedHumanInputError("HOSTED_INPUT_INVALID", "Invalid hosted key input");
            }
            return { kind: "key", key: record.key };
        default:
            throw new HostedHumanInputError("HOSTED_INPUT_INVALID", "Invalid hosted Human input");
    }
}
/**
 * Control-plane Human-input bridge. It has no retry queue: at most one input is in flight, a second
 * concurrent input fails closed, and transport failure closes the bridge. The worker generation is
 * carried in every envelope and revalidated again by HostedWorkerRouteGate on the worker.
 */
export class HostedHumanInputBridge {
    registry;
    currentOperator;
    peer;
    #binding;
    #busy = false;
    #closed = false;
    constructor(binding, registry, currentOperator, peer) {
        this.registry = registry;
        this.currentOperator = currentOperator;
        this.peer = peer;
        this.#binding = {
            operator: { ...binding.operator },
            worker: { ...binding.worker }
        };
    }
    async dispatch(value) {
        if (this.#closed) {
            throw new HostedHumanInputError("HOSTED_INPUT_CLOSED", "Hosted Human input bridge is closed");
        }
        if (this.#busy) {
            throw new HostedHumanInputError("HOSTED_INPUT_BUSY", "Hosted Human input is already in flight");
        }
        const input = parseHostedHumanInput(value);
        assertHostedOperatorBindingCurrent(this.#binding, this.currentOperator(), this.registry);
        this.#busy = true;
        try {
            await this.peer.sendInput({
                version: HOSTED_WORKER_DATA_PROTOCOL_VERSION,
                type: "human_input",
                interventionId: this.#binding.worker.interventionId,
                epoch: this.#binding.worker.epoch,
                workerGeneration: this.#binding.worker.workerGeneration,
                input
            });
        }
        catch (error) {
            if (error instanceof HostedHumanInputError && error.code === "HOSTED_INPUT_STALE_ROUTE") {
                throw error;
            }
            this.#closed = true;
            throw new HostedHumanInputError("HOSTED_INPUT_TRANSPORT_FAILURE", "Hosted Human input transport failed");
        }
        finally {
            this.#busy = false;
        }
    }
    close() {
        this.#closed = true;
    }
}
/**
 * Worker-side generation gate for one authenticated outbound control channel.
 *
 * Worker/principal identity is established by the authenticated channel outside peer messages.
 * Control `bind`/`revoke` messages create only exact generation-scoped route admission. Human input
 * envelopes are applied exactly once by the caller and are never queued/replayed by this gate.
 */
export class HostedWorkerRouteGate {
    #workerGeneration;
    #routes = new Map();
    applyControl(message) {
        if (message.version !== 1) {
            throw new HostedHumanInputError("HOSTED_INPUT_STALE_ROUTE", "Hosted worker control version is stale");
        }
        if (message.type === "registered") {
            if (!Number.isSafeInteger(message.workerGeneration) || message.workerGeneration <= 0) {
                throw new HostedHumanInputError("HOSTED_INPUT_STALE_ROUTE", "Hosted worker generation is invalid");
            }
            if (this.#workerGeneration !== undefined && this.#workerGeneration !== message.workerGeneration) {
                throw new HostedHumanInputError("HOSTED_INPUT_STALE_ROUTE", "Hosted worker generation changed on one channel");
            }
            this.#workerGeneration = message.workerGeneration;
            return;
        }
        if (this.#workerGeneration === undefined || message.workerGeneration !== this.#workerGeneration) {
            throw new HostedHumanInputError("HOSTED_INPUT_STALE_ROUTE", "Hosted worker control generation is stale");
        }
        const existing = this.#routes.get(message.interventionId);
        if (message.type === "bind") {
            if (existing && existing.epoch > message.epoch) {
                throw new HostedHumanInputError("HOSTED_INPUT_STALE_ROUTE", "Hosted worker route epoch is stale");
            }
            this.#routes.set(message.interventionId, {
                interventionId: message.interventionId,
                epoch: message.epoch,
                workerGeneration: message.workerGeneration
            });
            return;
        }
        if (!existing
            || existing.epoch !== message.epoch
            || existing.workerGeneration !== message.workerGeneration) {
            throw new HostedHumanInputError("HOSTED_INPUT_STALE_ROUTE", "Hosted worker revoke route is stale");
        }
        this.#routes.delete(message.interventionId);
    }
    async applyHumanInput(envelope, onInput) {
        if (envelope.version !== HOSTED_WORKER_DATA_PROTOCOL_VERSION
            || envelope.type !== "human_input"
            || this.#workerGeneration === undefined
            || envelope.workerGeneration !== this.#workerGeneration) {
            throw new HostedHumanInputError("HOSTED_INPUT_STALE_ROUTE", "Hosted Human input generation is stale");
        }
        const route = this.#routes.get(envelope.interventionId);
        if (!route
            || route.epoch !== envelope.epoch
            || route.workerGeneration !== envelope.workerGeneration) {
            throw new HostedHumanInputError("HOSTED_INPUT_STALE_ROUTE", "Hosted Human input route is stale");
        }
        const input = parseHostedHumanInput(envelope.input);
        await onInput(input);
    }
}
//# sourceMappingURL=hosted-worker-data.js.map