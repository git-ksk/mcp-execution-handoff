import assert from "node:assert/strict";
import test from "node:test";
import {
  ExecutionHandoffState,
  HostedInterventionRouteLifecycle,
  HostedLifecycleRouteError,
  HostedWorkerControlChannel,
  HostedWorkerControlChannelError,
  HostedWorkerRegistry,
  bindHostedOperatorSession,
  type HostedWorkerControlMessage,
  type HostedWorkerControlPeer
} from "../src/core/index.js";

const PRINCIPAL = "a".repeat(64);
const CHANNEL = "b".repeat(64);

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function fixture(expiresAt = 10_000) {
  let now = 1_000;
  const state = new ExecutionHandoffState<never, "hosted_test">(
    () => now,
    () => "intervention-1"
  );
  const begun = state.begin({ reason: "hosted_test", resumePolicy: "revalidate" });
  const human = state.claimHuman(begun.id);

  const registry = new HostedWorkerRegistry(() => now);
  const messages: HostedWorkerControlMessage[] = [];
  let revokeGate: ReturnType<typeof deferred> | undefined;
  let failRevoke = false;
  const peer: HostedWorkerControlPeer = {
    async send(message) {
      messages.push({ ...message });
      if (message.type === "revoke") {
        if (failRevoke) throw new Error("synthetic revoke failure");
        if (revokeGate) await revokeGate.promise;
      }
    }
  };
  const channel = await HostedWorkerControlChannel.open(registry, {
    workerId: "worker-a",
    principalBinding: PRINCIPAL,
    channelBinding: CHANNEL
  }, peer);
  const route = await channel.bindIntervention({
    interventionId: human.id,
    epoch: human.epoch,
    principalBinding: PRINCIPAL
  });
  const binding = bindHostedOperatorSession({
    sessionId: "operator-1",
    interventionId: human.id,
    epoch: human.epoch,
    principalBinding: PRINCIPAL,
    expiresAt,
    viewerGeneration: 1
  }, route, registry, now);

  const lifecycle = new HostedInterventionRouteLifecycle(
    state,
    channel,
    binding,
    () => now
  );

  return {
    state,
    registry,
    route,
    lifecycle,
    messages,
    setNow(value: number) { now = value; },
    blockRevoke() {
      revokeGate = deferred();
      return revokeGate;
    },
    setFailRevoke(value: boolean) { failRevoke = value; }
  };
}

test("Done revokes hosted route before canonical lifecycle enters verifying", async () => {
  const f = await fixture();
  const gate = f.blockRevoke();

  const pending = f.lifecycle.markHumanDone();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(f.state.getActive()?.status, "human_active");
  assert.equal(f.state.getAuthority(), "human");
  assert.throws(() => f.registry.assertCurrent(f.route), /no longer current/);

  gate.resolve();
  const verifying = await pending;
  assert.equal(verifying.status, "verifying");
  assert.equal(verifying.epoch, 2);
  assert.equal(f.state.getAuthority(), "none");

  assert.throws(() => f.state.resumeAgent(verifying.id));
  const ready = f.state.markVerified(verifying.id);
  const resume = f.state.resumeAgent(ready.id);
  assert.equal(resume.resumePolicy, "revalidate");
  assert.equal(f.state.getAuthority(), "agent");
});

test("Cancel restores Agent authority only after hosted revoke completes", async () => {
  const f = await fixture();
  const gate = f.blockRevoke();

  const pending = f.lifecycle.cancelHuman();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(f.state.getAuthority(), "human");
  assert.ok(f.state.getActive());
  assert.throws(() => f.registry.assertCurrent(f.route), /no longer current/);

  gate.resolve();
  await pending;
  assert.equal(f.state.getActive(), undefined);
  assert.equal(f.state.getAuthority(), "agent");
  assert.equal(f.state.getResourceEpoch(), 2);
});

test("Cancel fails closed and never restores Agent when worker revoke delivery fails", async () => {
  const f = await fixture();
  f.setFailRevoke(true);

  await assert.rejects(
    f.lifecycle.cancelHuman(),
    (error: unknown) => error instanceof HostedWorkerControlChannelError
      && error.code === "HOSTED_WORKER_CHANNEL_UNAVAILABLE"
  );
  assert.equal(f.state.getActive()?.status, "human_active");
  assert.equal(f.state.getAuthority(), "human");
  assert.throws(() => f.registry.assertCurrent(f.route), /no longer current/);
});

test("operator expiry revokes hosted route and enters verifying without claiming semantic success", async () => {
  const f = await fixture(2_000);

  await assert.rejects(
    f.lifecycle.expireOperatorSession(),
    (error: unknown) => error instanceof HostedLifecycleRouteError
      && error.code === "HOSTED_OPERATOR_SESSION_NOT_EXPIRED"
  );
  assert.equal(f.state.getAuthority(), "human");
  f.registry.assertCurrent(f.route);

  f.setNow(2_000);
  const verifying = await f.lifecycle.expireOperatorSession();
  assert.equal(verifying.status, "verifying");
  assert.equal(f.state.getAuthority(), "none");
  assert.throws(() => f.registry.assertCurrent(f.route), /no longer current/);
  assert.throws(() => f.state.resumeAgent(verifying.id));
});

test("expiry revoke failure leaves canonical authority Human-active and Agent fenced", async () => {
  const f = await fixture(2_000);
  f.setNow(2_000);
  f.setFailRevoke(true);

  await assert.rejects(f.lifecycle.expireOperatorSession());
  assert.equal(f.state.getActive()?.status, "human_active");
  assert.equal(f.state.getAuthority(), "human");
});

test("Done revoke failure leaves canonical authority Human-active and Agent fenced", async () => {
  const f = await fixture();
  f.setFailRevoke(true);

  await assert.rejects(f.lifecycle.markHumanDone());
  assert.equal(f.state.getActive()?.status, "human_active");
  assert.equal(f.state.getAuthority(), "human");
});

test("hosted lifecycle route must match the canonical intervention id and epoch", async () => {
  const f = await fixture();
  f.state.markHumanComplete("intervention-1");
  await assert.rejects(
    f.lifecycle.markHumanDone(),
    (error: unknown) => error instanceof HostedLifecycleRouteError
      && error.code === "HOSTED_LIFECYCLE_ROUTE_MISMATCH"
  );
});
