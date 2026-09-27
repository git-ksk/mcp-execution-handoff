import type { ExecutionHandoffState, ExecutionIntervention } from "./lifecycle.js";
import type { HostedOperatorRouteBinding } from "./hosted-operator-binding.js";
import type { HostedWorkerControlChannel } from "./hosted-worker-channel.js";
export type HostedLifecycleRouteErrorCode = "HOSTED_LIFECYCLE_ROUTE_MISMATCH" | "HOSTED_LIFECYCLE_NOT_HUMAN_ACTIVE" | "HOSTED_OPERATOR_SESSION_NOT_EXPIRED";
export declare class HostedLifecycleRouteError extends Error {
    readonly code: HostedLifecycleRouteErrorCode;
    constructor(code: HostedLifecycleRouteErrorCode, message: string);
}
/**
 * Thin ordering layer between the canonical ExecutionHandoffState and one hosted worker route.
 *
 * It is intentionally not another lifecycle FSM. The existing ExecutionHandoffState remains the
 * only source of Human/Agent authority. This helper only guarantees that hosted routing authority
 * is revoked before Done, Cancel, or operator-session expiry is allowed to advance that lifecycle.
 */
export declare class HostedInterventionRouteLifecycle<TAction, TReason extends string = string> {
    #private;
    private readonly state;
    private readonly channel;
    private readonly binding;
    private readonly now;
    constructor(state: ExecutionHandoffState<TAction, TReason>, channel: HostedWorkerControlChannel, binding: HostedOperatorRouteBinding, now?: () => number);
    /**
     * Human Done is not semantic success. Revoke hosted mutation delivery first, then move the
     * canonical intervention into verifying/authority-none. Consumer verification remains mandatory.
     */
    markHumanDone(): Promise<ExecutionIntervention<TAction, TReason>>;
    /**
     * Cancel may restore Agent authority only after hosted Human routing is successfully revoked.
     * If revoke/propagation fails, ExecutionHandoffState is deliberately left Human-active.
     */
    cancelHuman(): Promise<void>;
    /**
     * Operator-session expiry terminates Human routing but does not attest task success. After
     * successful revoke it enters verifying, forcing fresh consumer verification/reissue policy
     * before Agent execution can resume.
     */
    expireOperatorSession(): Promise<ExecutionIntervention<TAction, TReason>>;
}
//# sourceMappingURL=hosted-lifecycle-route.d.ts.map