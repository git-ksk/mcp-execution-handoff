const baseUrl = process.argv[2];
const revision = process.argv[3];
if (!baseUrl || !/^https:\/\//.test(baseUrl)) throw new Error("HTTPS Cloud Run URL is required");
if (!revision || !/^[0-9a-f]{40}$/.test(revision)) throw new Error("Exact git revision is required");

const response = await fetch(new URL("/acceptance-result", baseUrl), {
  cache: "no-store",
  redirect: "error",
  signal: AbortSignal.timeout(10_000)
});
if (!response.ok) throw new Error(`Acceptance result returned HTTP ${response.status}`);
const result = await response.json();
const requiredTrue = [
  "targetReady",
  "exactTargetBounded",
  "fallbackObserved",
  "staleDirectLocatorRejected",
  "staleDirectGenerationFenced",
  "staleWebSocketLocatorRejected",
  "tapObserved",
  "focusObserved",
  "textObserved",
  "backspaceObserved",
  "scrollObserved",
  "enterKeyDownObserved",
  "enterKeyUpObserved",
  "submitObserved",
  "doneObserved",
  "verificationStartedObserved",
  "teardownCompleted"
];

const failures = [];
if (result.revision !== revision) failures.push("revision");
if (result.turnConfigured !== false) failures.push("turnConfigured");
if (result.lastTransport !== "websocket_relay") failures.push("lastTransport");
if (result.lastFallbackReason !== "transport_unavailable") failures.push("lastFallbackReason");
if (!Number.isSafeInteger(result.generation) || result.generation < 2) failures.push("generation");
if (!Number.isSafeInteger(result.transitionCount) || result.transitionCount < 1) failures.push("transitionCount");
if (result.wssFailureCode !== "none") failures.push("wssFailureCode");
const cleanTeardownHelperClose = result.teardownCompleted === true
  && result.wssSurfaceFailure === "helper_closed"
  && result.wssSurfaceFailureHelperStopReason === "explicit_stop"
  && result.wssSurfaceFailureHelperExitKind === "clean"
  && result.wssSurfaceFailureHelperCrashReason === "none";
if (result.wssSurfaceFailure !== "none" && !cleanTeardownHelperClose) {
  failures.push("wssSurfaceFailure");
}
if (result.wssChannelLastInputStage !== "applied") failures.push("wssChannelLastInputStage");
if (result.wssSurfaceInputBoundaryStage !== "acknowledged") failures.push("wssSurfaceInputBoundaryStage");
if (result.wssLastInputStage !== "applied") failures.push("wssLastInputStage");
if (!Number.isSafeInteger(result.wssSurfaceInputAttempts) || result.wssSurfaceInputAttempts < 6) {
  failures.push("wssSurfaceInputAttempts");
}
for (const key of requiredTrue) if (result[key] !== true) failures.push(key);

if (failures.length > 0) {
  console.error(`MANAGED_PHYSICAL_ACCEPTANCE_FAILED:${failures.join(",")}`);
  process.exit(1);
}
console.log("MANAGED_PHYSICAL_ACCEPTANCE_OK");
