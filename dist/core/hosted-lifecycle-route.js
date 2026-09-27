export class HostedLifecycleRouteError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "HostedLifecycleRouteError";
    }
}
/**
 * Thin ordering layer between the canonical ExecutionHandoffState and one hosted worker route.
 *
 * It is intentionally not another lifecycle FSM. The existing ExecutionHandoffState remains the
 * only source of Human/Agent authority. This helper only guarantees that hosted routing authority
 * is revoked before Done, Cancel, or operator-session expiry is allowed to advance that lifecycle.
 */
export class HostedInterventionRouteLifecycle {
    state;
    channel;
    binding;
    now;
    constructor(state, channel, binding, now = Date.now) {
        this.state = state;
        this.channel = channel;
        this.binding = binding;
        this.now = now;
    }
    /**
     * Human Done is not semantic success. Revoke hosted mutation delivery first, then move the
     * canonical intervention into verifying/authority-none. Consumer verification remains mandatory.
     */
    async markHumanDone() {
        const active = this.#requireHumanActive();
        await this.channel.revokeIntervention(this.binding.worker);
        return this.state.markHumanComplete(active.id);
    }
    /**
     * Cancel may restore Agent authority only after hosted Human routing is successfully revoked.
     * If revoke/propagation fails, ExecutionHandoffState is deliberately left Human-active.
     */
    async cancelHuman() {
        const active = this.#requireHumanActive();
        await this.channel.revokeIntervention(this.binding.worker);
        this.state.cancel(active.id);
    }
    /**
     * Operator-session expiry terminates Human routing but does not attest task success. After
     * successful revoke it enters verifying, forcing fresh consumer verification/reissue policy
     * before Agent execution can resume.
     */
    async expireOperatorSession() {
        const active = this.#requireHumanActive();
        const now = this.now();
        if (!Number.isSafeInteger(now) || now < this.binding.operator.expiresAt) {
            throw new HostedLifecycleRouteError("HOSTED_OPERATOR_SESSION_NOT_EXPIRED", "Hosted operator session has not expired");
        }
        await this.channel.revokeIntervention(this.binding.worker);
        return this.state.markHumanComplete(active.id);
    }
    #requireHumanActive() {
        const active = this.state.getActive();
        if (!active) {
            throw new HostedLifecycleRouteError("HOSTED_LIFECYCLE_ROUTE_MISMATCH", "Hosted lifecycle has no active intervention");
        }
        if (active.id !== this.binding.worker.interventionId
            || active.epoch !== this.binding.worker.epoch
            || this.binding.operator.interventionId !== active.id
            || this.binding.operator.epoch !== active.epoch
            || this.binding.operator.principalBinding !== this.binding.worker.principalBinding) {
            throw new HostedLifecycleRouteError("HOSTED_LIFECYCLE_ROUTE_MISMATCH", "Hosted lifecycle does not match the bound intervention route");
        }
        if (active.status !== "human_active") {
            throw new HostedLifecycleRouteError("HOSTED_LIFECYCLE_NOT_HUMAN_ACTIVE", "Hosted lifecycle termination requires active Human authority");
        }
        return active;
    }
}
//# sourceMappingURL=hosted-lifecycle-route.js.map