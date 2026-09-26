import { recoverHandoffCheckpoint } from "./checkpoint.js";
/**
 * Project the existing v0.3 checkpoint into hosted recovery orchestration.
 *
 * Hosted recovery deliberately does not restore worker identity/generation, channel binding,
 * operator session id/generation, locator/capability, frame/input state, or any target/session
 * content. A worker must authenticate again and an operator session must be freshly issued before
 * hosted delivery can resume.
 */
export function recoverHostedControlPlane(value, now) {
    const recovered = recoverHandoffCheckpoint(value, now);
    return {
        version: 1,
        interventionId: recovered.interventionId,
        epoch: recovered.epoch,
        principalBinding: recovered.principalBinding,
        resumePolicy: recovered.resumePolicy,
        ...(recovered.actionDigest === undefined ? {} : { actionDigest: recovered.actionDigest }),
        recovery: "reissue_and_revalidate",
        workerRoute: "reconnect_required",
        operatorSession: "reissue_required"
    };
}
//# sourceMappingURL=hosted-recovery.js.map