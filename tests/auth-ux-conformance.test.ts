import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionHandoffError, ExecutionHandoffState } from "../src/core/lifecycle.js";
import { TakeoverSessionError, TakeoverSessionManager } from "../src/browser-takeover/session.js";

const PRINCIPAL = "synthetic-auth-principal-00000001";
const CLIENT_A = "synthetic-auth-client-a-00000001";
const CLIENT_B = "synthetic-auth-client-b-00000001";

type VerificationOutcome =
  | "still_at_login"
  | "verification_failed"
  | "post_navigation_unknown"
  | "verified_success";

type AuthAction = { kind: "synthetic_sign_in" };
type AuthReason = "sign_in";

function fixture() {
  let now = 10_000;
  let interventionId = 0;
  let sessionId = 0;
  const state = new ExecutionHandoffState<AuthAction, AuthReason>(
    () => now,
    () => `synthetic-auth-${++interventionId}`
  );
  const sessions = new TakeoverSessionManager(
    1_000,
    () => now,
    () => `synthetic-session-${++sessionId}`,
    Buffer.alloc(32, 7),
    250,
    1_000
  );
  return {
    state,
    sessions,
    advance(ms: number) { now += ms; }
  };
}

function beginHuman(f = fixture()) {
  const intervention = f.state.begin({
    reason: "sign_in",
    action: { kind: "synthetic_sign_in" },
    resumePolicy: "never_replay"
  });
  const locator = f.sessions.ensure(intervention.id, intervention.epoch, PRINCIPAL);
  f.state.claimHuman(intervention.id);
  const grant = f.sessions.claimClient(locator.id, PRINCIPAL, CLIENT_A);
  const completion = f.sessions.issueCompletionCapability(locator.id, PRINCIPAL);
  return { ...f, intervention, locator, grant, completion };
}

function humanDone(h: ReturnType<typeof beginHuman>) {
  const transport = h.sessions.complete(h.locator.id, h.completion, PRINCIPAL);
  assert.equal(transport.alreadyCompleted, false);
  const verifying = h.state.markHumanComplete(h.intervention.id);
  assert.equal(verifying.status, "verifying");
  assert.equal(h.state.getAuthority(), "none");
  assert.throws(
    () => h.state.assertAgentAuthority(),
    (error: unknown) => error instanceof ExecutionHandoffError
      && error.code === "AGENT_AUTHORITY_SUSPENDED"
  );
  return verifying;
}

function consumerOutcome(h: ReturnType<typeof beginHuman>, outcome: VerificationOutcome): string {
  if (outcome === "verified_success") {
    h.state.markVerified(h.intervention.id);
    const decision = h.state.resumeAgent(h.intervention.id);
    assert.equal(decision.resumePolicy, "never_replay");
    return "verified_resume";
  }
  if (outcome === "still_at_login") {
    const returned = h.state.returnToHuman(h.intervention.id);
    assert.equal(returned.status, "human_active");
    const fresh = h.sessions.ensure(returned.id, returned.epoch, PRINCIPAL);
    assert.notEqual(fresh.id, h.locator.id);
    assert.throws(
      () => h.sessions.validateLocator(h.locator.id, PRINCIPAL),
      (error: unknown) => error instanceof TakeoverSessionError
        && error.code === "TAKEOVER_NOT_FOUND"
    );
    return "fresh_human_required";
  }
  // Failed or unknown semantic verification keeps Agent mutation fenced until the consumer
  // explicitly cancels/reissues under its own policy. Handoff never converts either to success.
  assert.equal(h.state.getActive()?.status, "verifying");
  assert.equal(h.state.getAuthority(), "none");
  return outcome === "verification_failed" ? "verification_failed" : "result_unknown";
}

test("synthetic auth UX distinguishes Human Done from four consumer verification outcomes", () => {
  const expected = new Map<VerificationOutcome, string>([
    ["still_at_login", "fresh_human_required"],
    ["verification_failed", "verification_failed"],
    ["post_navigation_unknown", "result_unknown"],
    ["verified_success", "verified_resume"]
  ]);
  for (const [outcome, result] of expected) {
    const h = beginHuman();
    humanDone(h);
    assert.equal(consumerOutcome(h, outcome), result);
    if (outcome !== "verified_success" && outcome !== "still_at_login") {
      assert.throws(() => h.state.assertAgentAuthority(), /Agent authority is suspended/);
      h.state.cancel(h.intervention.id);
      assert.equal(h.state.getAuthority(), "agent");
    }
  }
});

test("synthetic auth UX cancellation fences the locator and is never completion", () => {
  const f = fixture();
  const intervention = f.state.begin({ reason: "sign_in", resumePolicy: "never_replay" });
  const locator = f.sessions.ensure(intervention.id, intervention.epoch, PRINCIPAL);
  f.sessions.revokeForIntervention(intervention.id);
  f.state.cancel(intervention.id);
  assert.equal(f.state.getAuthority(), "agent");
  assert.equal(f.state.getResourceEpoch(), intervention.epoch + 1);
  assert.throws(
    () => f.sessions.validateLocator(locator.id, PRINCIPAL),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_NOT_FOUND"
  );
});

test("synthetic auth UX expiry remains input-required rather than authenticated", () => {
  const f = fixture();
  const intervention = f.state.begin({ reason: "sign_in", resumePolicy: "never_replay" });
  const locator = f.sessions.ensure(intervention.id, intervention.epoch, PRINCIPAL);
  f.advance(1_000);
  assert.throws(
    () => f.sessions.claimClient(locator.id, PRINCIPAL, CLIENT_A),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_EXPIRED"
  );
  assert.equal(f.state.getActive()?.status, "awaiting_human");
  assert.equal(f.state.getAuthority(), "none");
});

test("synthetic auth UX transport loss is not Done and cannot restore Agent authority", () => {
  const h = beginHuman();
  h.sessions.releaseClientGeneration(
    h.locator.id,
    PRINCIPAL,
    h.grant.clientBinding,
    h.grant.clientGeneration
  );
  assert.equal(h.state.getActive()?.status, "human_active");
  assert.equal(h.state.getAuthority(), "human");
  assert.throws(
    () => h.sessions.verify(h.locator.id, h.grant.capability, PRINCIPAL, CLIENT_A),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_FORBIDDEN"
  );
});

test("synthetic auth UX reconnect rotates generation and rejects stale Human input authority", () => {
  const h = beginHuman();
  h.sessions.releaseClientGeneration(
    h.locator.id,
    PRINCIPAL,
    h.grant.clientBinding,
    h.grant.clientGeneration
  );
  const next = h.sessions.reconnectClient(h.locator.id, PRINCIPAL, h.grant.reconnectHandle, CLIENT_B);
  assert.equal(next.clientGeneration, h.grant.clientGeneration + 1);
  assert.notEqual(next.capability, h.grant.capability);
  assert.throws(
    () => h.sessions.beginBoundUse(h.locator.id, PRINCIPAL, CLIENT_A, h.grant.clientGeneration),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_FORBIDDEN"
  );
  assert.equal(
    h.sessions.beginBoundUse(h.locator.id, PRINCIPAL, CLIENT_B, next.clientGeneration).clientGeneration,
    next.clientGeneration
  );
  h.sessions.endUse(h.locator.id, PRINCIPAL, CLIENT_B, next.clientGeneration);
});

test("synthetic auth UX observation record is content-free and mode switching stays unsupported", () => {
  const presentationPolicy = {
    modeSwitch: "unsupported",
    lifecycle: "verifying",
    outcome: "result_unknown",
    transport: "human_control"
  } as const;
  assert.equal(presentationPolicy.modeSwitch, "unsupported");
  const encoded = JSON.stringify(presentationPolicy);
  assert.doesNotMatch(
    encoded,
    /password|otp|mfa|credential|cookie|token|account|email|phone|framebuffer|humanInput|url|origin|pageText/i
  );
});
