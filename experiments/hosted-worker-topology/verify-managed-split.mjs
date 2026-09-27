const baseUrl = process.argv[2];
const revision = process.argv[3];
if (!baseUrl || !/^https:\/\//.test(baseUrl)) throw new Error("HTTPS control-plane URL required");
if (!/^[0-9a-f]{40}$/.test(revision || "")) throw new Error("exact revision required");

const response = await fetch(new URL("/acceptance-result", baseUrl), {
  cache: "no-store",
  signal: AbortSignal.timeout(10_000)
});
if (!response.ok) throw new Error("acceptance result unavailable");
const value = await response.json();
const required = [
  "cloudControlPlane",
  "outboundWorkerOnly",
  "authenticatedRegistration",
  "staleWorkerFrameRejected",
  "staleViewerRejected",
  "explicitRevokeObserved",
  "revokedWorkerRouteRejected",
  "recoveryRequiresReissue",
  "workerReconnectObserved",
  "doneRouteRevoked",
  "cancelRouteRevoked",
  "expiryRouteRevoked",
  "freshAgentRevalidationRequired",
  "expiryFreshAgentRevalidationRequired",
  "acceptanceDone"
];
const failures = [];
if (value.revision !== revision) failures.push("revision");
if (value.firstWorkerGeneration !== 1) failures.push("firstWorkerGeneration");
if (value.successorWorkerGeneration !== 2) failures.push("successorWorkerGeneration");
if (!Number.isSafeInteger(value.humanInputsApplied) || value.humanInputsApplied < 2) failures.push("humanInputsApplied");
if (!Number.isSafeInteger(value.framesDelivered) || value.framesDelivered < 2) failures.push("framesDelivered");
if (value.failure !== "none") failures.push("failure");
for (const key of required) if (value[key] !== true) failures.push(key);
if (failures.length) {
  console.error("MANAGED_SPLIT_ACCEPTANCE_FAILED:" + failures.join(","));
  process.exit(1);
}
console.log("MANAGED_SPLIT_ACCEPTANCE_OK");
