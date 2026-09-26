import { type HostedOperatorRouteBinding } from "./hosted-operator-binding.js";
import type { HostedWorkerControlMessage } from "./hosted-worker-channel.js";
import type { HostedWorkerRegistry } from "./hosted-worker.js";
export declare const HOSTED_WORKER_DATA_PROTOCOL_VERSION: 1;
export type HostedHumanInput = {
    kind: "tap";
    x: number;
    y: number;
} | {
    kind: "scroll";
    deltaY: number;
} | {
    kind: "text";
    text: string;
} | {
    kind: "key";
    key: string;
};
export interface HostedWorkerInputEnvelope {
    version: typeof HOSTED_WORKER_DATA_PROTOCOL_VERSION;
    type: "human_input";
    interventionId: string;
    epoch: number;
    workerGeneration: number;
    input: HostedHumanInput;
}
export interface HostedHumanInputPeer {
    /** Resolve only after the worker generation gate accepted and applied this exact input. */
    sendInput(message: Readonly<HostedWorkerInputEnvelope>): void | Promise<void>;
}
export declare class HostedHumanInputError extends Error {
    readonly code: "HOSTED_INPUT_INVALID" | "HOSTED_INPUT_BUSY" | "HOSTED_INPUT_CLOSED" | "HOSTED_INPUT_TRANSPORT_FAILURE" | "HOSTED_INPUT_STALE_ROUTE";
    constructor(code: "HOSTED_INPUT_INVALID" | "HOSTED_INPUT_BUSY" | "HOSTED_INPUT_CLOSED" | "HOSTED_INPUT_TRANSPORT_FAILURE" | "HOSTED_INPUT_STALE_ROUTE", message: string);
}
export declare function parseHostedHumanInput(value: unknown): HostedHumanInput;
/**
 * Control-plane Human-input bridge. It has no retry queue: at most one input is in flight, a second
 * concurrent input fails closed, and transport failure closes the bridge. The worker generation is
 * carried in every envelope and revalidated again by HostedWorkerRouteGate on the worker.
 */
export declare class HostedHumanInputBridge {
    #private;
    private readonly registry;
    private readonly currentOperator;
    private readonly peer;
    constructor(binding: HostedOperatorRouteBinding, registry: HostedWorkerRegistry, currentOperator: () => unknown, peer: HostedHumanInputPeer);
    dispatch(value: unknown): Promise<void>;
    close(): void;
}
/**
 * Worker-side generation gate for one authenticated outbound control channel.
 *
 * Worker/principal identity is established by the authenticated channel outside peer messages.
 * Control `bind`/`revoke` messages create only exact generation-scoped route admission. Human input
 * envelopes are applied exactly once by the caller and are never queued/replayed by this gate.
 */
export declare class HostedWorkerRouteGate {
    #private;
    applyControl(message: Readonly<HostedWorkerControlMessage>): void;
    applyHumanInput(envelope: Readonly<HostedWorkerInputEnvelope>, onInput: (input: HostedHumanInput) => void | Promise<void>): Promise<void>;
}
//# sourceMappingURL=hosted-worker-data.d.ts.map