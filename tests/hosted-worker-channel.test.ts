import assert from "node:assert/strict";
import test from "node:test";
import {
  HostedWorkerControlChannel,
  HostedWorkerControlChannelError,
  HostedWorkerRegistry,
  HostedWorkerRegistryError,
  type HostedWorkerControlMessage,
  type HostedWorkerControlPeer
} from "../src/core/index.js";

const PRINCIPAL = "a".repeat(64);
const CHANNEL_A = "b".repeat(64);
const CHANNEL_B = "c".repeat(64);

function peerFixture(failAt = -1) {
  const messages: HostedWorkerControlMessage[] = [];
  let sends = 0;
  let closes = 0;
  const peer: HostedWorkerControlPeer = {
    async send(message) {
      sends += 1;
      if (sends === failAt) throw new Error("synthetic transport failure");
      messages.push({ ...message });
    },
    async close() {
      closes += 1;
    }
  };
  return { peer, messages, closes: () => closes };
}

test("authenticated outbound worker channel registers from trusted context and exposes no channel binding", async () => {
  const registry = new HostedWorkerRegistry(() => 1_000);
  const fixture = peerFixture();
  const channel = await HostedWorkerControlChannel.open(registry, {
    workerId: "worker-a",
    principalBinding: PRINCIPAL,
    channelBinding: CHANNEL_A
  }, fixture.peer);

  assert.deepEqual(channel.registration(), {
    workerId: "worker-a",
    principalBinding: PRINCIPAL,
    generation: 1,
    registeredAt: 1_000
  });
  assert.deepEqual(fixture.messages, [{
    version: 1,
    type: "registered",
    workerGeneration: 1
  }]);
  assert.doesNotMatch(JSON.stringify(channel.registration()), /channel|token|credential/i);
});

test("control bind derives worker identity and generation from the authenticated channel", async () => {
  const registry = new HostedWorkerRegistry();
  const fixture = peerFixture();
  const channel = await HostedWorkerControlChannel.open(registry, {
    workerId: "worker-a",
    principalBinding: PRINCIPAL,
    channelBinding: CHANNEL_A
  }, fixture.peer);

  const route = await channel.bindIntervention({
    interventionId: "intervention-1",
    epoch: 5,
    principalBinding: PRINCIPAL
  });
  assert.equal(route.workerId, "worker-a");
  assert.equal(route.workerGeneration, 1);
  channel.assertCurrent(route);
  assert.deepEqual(fixture.messages.at(-1), {
    version: 1,
    type: "bind",
    interventionId: "intervention-1",
    epoch: 5,
    workerGeneration: 1
  });
});

test("bind delivery failure fences the worker generation and all routes before surfacing transport failure", async () => {
  const registry = new HostedWorkerRegistry();
  const fixture = peerFixture(2);
  const channel = await HostedWorkerControlChannel.open(registry, {
    workerId: "worker-a",
    principalBinding: PRINCIPAL,
    channelBinding: CHANNEL_A
  }, fixture.peer);

  await assert.rejects(
    channel.bindIntervention({
      interventionId: "intervention-1",
      epoch: 5,
      principalBinding: PRINCIPAL
    }),
    (error: unknown) => error instanceof HostedWorkerControlChannelError
      && error.code === "HOSTED_WORKER_CHANNEL_UNAVAILABLE"
  );
  assert.equal(registry.get("worker-a"), undefined);
  assert.equal(fixture.closes(), 1);
  await assert.rejects(
    channel.bindIntervention({
      interventionId: "intervention-2",
      epoch: 5,
      principalBinding: PRINCIPAL
    }),
    (error: unknown) => error instanceof HostedWorkerControlChannelError
      && error.code === "HOSTED_WORKER_CHANNEL_CLOSED"
  );
});

test("revoke fences local route before remote notification and failure cannot restore it", async () => {
  const registry = new HostedWorkerRegistry();
  const fixture = peerFixture(3);
  const channel = await HostedWorkerControlChannel.open(registry, {
    workerId: "worker-a",
    principalBinding: PRINCIPAL,
    channelBinding: CHANNEL_A
  }, fixture.peer);
  const route = await channel.bindIntervention({
    interventionId: "intervention-1",
    epoch: 8,
    principalBinding: PRINCIPAL
  });

  await assert.rejects(
    channel.revokeIntervention(route),
    (error: unknown) => error instanceof HostedWorkerControlChannelError
      && error.code === "HOSTED_WORKER_CHANNEL_UNAVAILABLE"
  );
  assert.throws(
    () => registry.assertCurrent(route),
    (error: unknown) => error instanceof HostedWorkerRegistryError
      && error.code === "HOSTED_WORKER_STALE_GENERATION"
  );
  assert.equal(registry.get("worker-a"), undefined);
});

test("disconnect revokes every route for exactly the current generation and reconnect gets a successor generation", async () => {
  const registry = new HostedWorkerRegistry();
  const firstFixture = peerFixture();
  const first = await HostedWorkerControlChannel.open(registry, {
    workerId: "worker-a",
    principalBinding: PRINCIPAL,
    channelBinding: CHANNEL_A
  }, firstFixture.peer);
  const routeA = await first.bindIntervention({
    interventionId: "intervention-a",
    epoch: 1,
    principalBinding: PRINCIPAL
  });
  const routeB = await first.bindIntervention({
    interventionId: "intervention-b",
    epoch: 2,
    principalBinding: PRINCIPAL
  });
  const revoked = await first.disconnect();
  assert.deepEqual(
    revoked.map((route) => route.interventionId).sort(),
    ["intervention-a", "intervention-b"]
  );
  assert.equal(firstFixture.closes(), 1);
  assert.throws(() => registry.assertCurrent(routeA), /no longer current/);
  assert.throws(() => registry.assertCurrent(routeB), /no longer current/);

  const secondFixture = peerFixture();
  const second = await HostedWorkerControlChannel.open(registry, {
    workerId: "worker-a",
    principalBinding: PRINCIPAL,
    channelBinding: CHANNEL_B
  }, secondFixture.peer);
  assert.equal(second.registration().generation, 2);
  assert.deepEqual(secondFixture.messages[0], {
    version: 1,
    type: "registered",
    workerGeneration: 2
  });
});

test("registration delivery failure does not leave an authenticated worker active", async () => {
  const registry = new HostedWorkerRegistry();
  const fixture = peerFixture(1);
  await assert.rejects(
    HostedWorkerControlChannel.open(registry, {
      workerId: "worker-a",
      principalBinding: PRINCIPAL,
      channelBinding: CHANNEL_A
    }, fixture.peer),
    (error: unknown) => error instanceof HostedWorkerControlChannelError
      && error.code === "HOSTED_WORKER_CHANNEL_UNAVAILABLE"
  );
  assert.equal(registry.get("worker-a"), undefined);
  assert.equal(fixture.closes(), 1);
});
