import assert from "node:assert/strict";
import test from "node:test";
import {
  CredentialSafeHumanSurfaceRuntime,
  ExecutionHandoffState,
  ExternalHumanSurfaceError,
  HUMAN_INTERACTION_POLICY_KINDS,
  HUMAN_SURFACE_KINDS,
  selectHumanInteractionPolicy,
  selectHumanSurface,
  type ExternalHumanSurfaceProvider,
  type HumanInteractionPolicyKind,
  type HumanSurfaceKind
} from "../src/core/index.js";

type Action = { kind: "search"; query: string };
type Reason = "access_challenge" | "sign_in" | "consent";

function handoffFixture() {
  let id = 0;
  const state = new ExecutionHandoffState<Action, Reason>(() => 1_000, () => `intervention-${++id}`);
  const intervention = state.begin({ reason: "sign_in", resumePolicy: "never_replay" });
  return { state, intervention };
}

function providerFixture(extra: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const provider: ExternalHumanSurfaceProvider = {
    kind: "system-browser-remote",
    async begin() {
      calls.push("begin");
      return {
        sessionId: "external-session-1",
        locator: "https://remote.example.test/session/external-session-1",
        expiresAt: 4_102_444_800_000,
        ...extra
      };
    },
    async revoke(sessionId) {
      calls.push(`revoke:${sessionId}`);
    }
  };
  return { provider, calls };
}

test("Human Interaction Policy has canonical names with source-compatible HumanSurface aliases", () => {
  const sensitive = new Set<Reason>(["sign_in", "consent"]);
  const canonical: HumanInteractionPolicyKind = selectHumanInteractionPolicy("sign_in", sensitive);
  const compatibility: HumanSurfaceKind = selectHumanSurface("sign_in", sensitive);

  assert.equal(canonical, "credential_safe_external");
  assert.equal(compatibility, canonical);
  assert.deepEqual(HUMAN_INTERACTION_POLICY_KINDS, ["automation_adjacent", "credential_safe_external"]);
  assert.equal(HUMAN_SURFACE_KINDS, HUMAN_INTERACTION_POLICY_KINDS);
  assert.equal(selectHumanInteractionPolicy("consent", sensitive), "credential_safe_external");
  assert.equal(selectHumanInteractionPolicy("access_challenge", sensitive), "automation_adjacent");
});

test("credential-safe external control cannot begin before Human authority owns the intervention", async () => {
  const { intervention } = handoffFixture();
  const { provider } = providerFixture();
  const runtime = new CredentialSafeHumanSurfaceRuntime(provider);
  await assert.rejects(
    runtime.begin(intervention, "principal-a"),
    (error: unknown) => error instanceof ExternalHumanSurfaceError && error.code === "EXTERNAL_SURFACE_STATE_CHANGED"
  );
});

test("credential-safe surface is principal and epoch bound and blocks concurrent ownership", async () => {
  const { state, intervention } = handoffFixture();
  const human = state.claimHuman(intervention.id);
  const { provider, calls } = providerFixture();
  const runtime = new CredentialSafeHumanSurfaceRuntime(provider);
  const first = await runtime.begin(human, "principal-a");
  const duplicate = await runtime.begin(human, "principal-a");
  assert.deepEqual(duplicate, first);
  assert.deepEqual(calls, ["begin"]);
  await assert.rejects(
    runtime.begin({ ...human, epoch: human.epoch + 1 }, "principal-a"),
    (error: unknown) => error instanceof ExternalHumanSurfaceError && error.code === "EXTERNAL_SURFACE_ACTIVE"
  );
  await assert.rejects(
    runtime.begin(human, "principal-b"),
    (error: unknown) => error instanceof ExternalHumanSurfaceError && error.code === "EXTERNAL_SURFACE_ACTIVE"
  );
  assert.throws(
    () => runtime.assertInactive(),
    (error: unknown) => error instanceof ExternalHumanSurfaceError && error.code === "EXTERNAL_SURFACE_ACTIVE"
  );
});


test("expired cached credential-safe surface is fenced and requires explicit fresh begin", async () => {
  const { state, intervention } = handoffFixture();
  const human = state.claimHuman(intervention.id);
  let now = 1_500;
  let generation = 0;
  const calls: string[] = [];
  const provider: ExternalHumanSurfaceProvider = {
    kind: "system-browser-remote",
    async begin() {
      generation += 1;
      calls.push(`begin:${generation}`);
      return {
        sessionId: `external-session-${generation}`,
        locator: `https://remote.example.test/session/external-session-${generation}`,
        expiresAt: now + 500
      };
    },
    async revoke(sessionId) {
      calls.push(`revoke:${sessionId}`);
      if (sessionId === "external-session-1") throw new Error("provider session already gone");
    }
  };
  const runtime = new CredentialSafeHumanSurfaceRuntime(provider, () => now);

  const first = await runtime.begin(human, "principal-a");
  assert.equal(first.sessionId, "external-session-1");
  assert.deepEqual(calls, ["begin:1"]);

  now = first.expiresAt!;
  assert.equal(runtime.getActive(), undefined);
  runtime.assertInactive();
  await assert.rejects(
    runtime.begin(human, "principal-a"),
    (error: unknown) => error instanceof ExternalHumanSurfaceError && error.code === "EXTERNAL_SURFACE_EXPIRED"
  );
  assert.deepEqual(calls, ["begin:1", "revoke:external-session-1"]);
  assert.equal(runtime.getActive(), undefined);
  assert.equal(state.getAuthority(), "human");

  const fresh = await runtime.begin(human, "principal-a");
  assert.equal(fresh.sessionId, "external-session-2");
  assert.deepEqual(calls, ["begin:1", "revoke:external-session-1", "begin:2"]);
});

test("already-expired provider grant is rejected and revoked best-effort", async () => {
  const { state, intervention } = handoffFixture();
  const human = state.claimHuman(intervention.id);
  const calls: string[] = [];
  const provider: ExternalHumanSurfaceProvider = {
    kind: "system-browser-remote",
    async begin() {
      calls.push("begin");
      return {
        sessionId: "expired-session",
        locator: "https://remote.example.test/session/expired-session",
        expiresAt: 2_000
      };
    },
    async revoke(sessionId) {
      calls.push(`revoke:${sessionId}`);
    }
  };
  const runtime = new CredentialSafeHumanSurfaceRuntime(provider, () => 2_000);

  await assert.rejects(
    runtime.begin(human, "principal-a"),
    (error: unknown) => error instanceof ExternalHumanSurfaceError && error.code === "EXTERNAL_SURFACE_EXPIRED"
  );
  assert.deepEqual(calls, ["begin", "revoke:expired-session"]);
  assert.equal(runtime.getActive(), undefined);
});

test("external provider data is narrowed to bounded control-plane fields only", async () => {
  const { state, intervention } = handoffFixture();
  const human = state.claimHuman(intervention.id);
  const { provider } = providerFixture({
    credential: "must-not-survive",
    cookie: "must-not-survive",
    token: "must-not-survive",
    screenshot: "must-not-survive"
  });
  const runtime = new CredentialSafeHumanSurfaceRuntime(provider);
  const active = await runtime.begin(human, "principal-a");
  const serialized = JSON.stringify(active);
  assert.equal(serialized.includes("must-not-survive"), false);
  assert.deepEqual(Object.keys(active).sort(), [
    "epoch",
    "expiresAt",
    "interventionId",
    "locator",
    "principalBinding",
    "providerKind",
    "sessionId"
  ]);
});


test("invalid provider grants are revoked best-effort and never become active", async () => {
  const { state, intervention } = handoffFixture();
  const human = state.claimHuman(intervention.id);
  const calls: string[] = [];
  const provider: ExternalHumanSurfaceProvider = {
    kind: "system-browser-remote",
    async begin() {
      calls.push("begin");
      return { sessionId: "invalid session id", locator: "https://remote.example.test/session/invalid" };
    },
    async revoke(sessionId) {
      calls.push(`revoke:${sessionId}`);
    }
  };
  const runtime = new CredentialSafeHumanSurfaceRuntime(provider);
  await assert.rejects(
    runtime.begin(human, "principal-a"),
    (error: unknown) => error instanceof ExternalHumanSurfaceError && error.code === "EXTERNAL_SURFACE_PROVIDER_INVALID"
  );
  assert.deepEqual(calls, ["begin", "revoke:invalid session id"]);
  assert.equal(runtime.getActive(), undefined);
});

test("external session must be revoked before automation can be restored", async () => {
  const { state, intervention } = handoffFixture();
  const human = state.claimHuman(intervention.id);
  const { provider, calls } = providerFixture();
  const runtime = new CredentialSafeHumanSurfaceRuntime(provider);
  await runtime.begin(human, "principal-a");
  await assert.rejects(
    runtime.revoke(human.id, human.epoch + 1, "principal-a"),
    (error: unknown) => error instanceof ExternalHumanSurfaceError && error.code === "EXTERNAL_SURFACE_STATE_CHANGED"
  );
  await runtime.revoke(human.id, human.epoch, "principal-a");
  assert.deepEqual(calls, ["begin", "revoke:external-session-1"]);
  runtime.assertInactive();
  const verifying = state.markHumanComplete(human.id);
  assert.equal(verifying.status, "verifying");
  assert.equal(state.getAuthority(), "none");
});
