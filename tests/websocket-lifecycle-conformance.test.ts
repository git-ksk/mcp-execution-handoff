import assert from "node:assert/strict";
import test from "node:test";
import { TakeoverSessionManager, type TakeoverCompletionResult } from "../src/browser-takeover/session.js";
import {
  ExperimentalWebSocketTakeoverSessionAuthority,
  type ExperimentalWebSocketAcceptedSession
} from "../src/browser-takeover/websocket-ingress.js";
import {
  ExperimentalWebSocketTakeoverChannel,
  type WebSocketTakeoverHumanInput,
  type WebSocketTakeoverServerMessage
} from "../src/browser-takeover/websocket-takeover.js";

// Exercise the real session -> WSS authority -> channel boundary. Only time and the peer/consumer
// are controlled; no mocked lease, sockets, target content, ICE or wall-clock sleeps are needed.
const PRINCIPAL = "conformance-principal";
const POLICY = { tap: true, scroll: true, text: false, key: false };
const TAP = JSON.stringify({ kind: "tap", x: 0.25, y: 0.75 });
const DONE = JSON.stringify({ kind: "done" });
const FRAME = { data: new Uint8Array([7]), width: 1, height: 1, mimeType: "image/png" as const };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(onCompleted?: (result: TakeoverCompletionResult) => void) {
  let now = 10_000;
  let id = 0;
  let ticketId = 0;
  let clientId = 0;
  const sessions = new TakeoverSessionManager(
    1_000, () => now, () => `conformance-session-${++id}`, Buffer.alloc(32, 7), 250, 1_000
  );
  const locator = sessions.ensure("intervention", 4, PRINCIPAL);
  const completions: TakeoverCompletionResult[] = [];
  const authority = new ExperimentalWebSocketTakeoverSessionAuthority(
    sessions, () => now,
    () => Buffer.alloc(32, ++ticketId).toString("base64url"),
    () => Buffer.alloc(24, ++clientId).toString("base64url"),
    { completed(result) { completions.push(result); onCompleted?.(result); } }
  );
  const ticket = authority.issueHandshakeTicket(locator.id, PRINCIPAL, POLICY);
  function connect(
    accepted = authority.accept(locator.id, ticket),
    onInput?: (input: WebSocketTakeoverHumanInput) => Promise<void>
  ) {
    const controls: WebSocketTakeoverServerMessage[] = [];
    const inputs: WebSocketTakeoverHumanInput[] = [];
    const frames: number[] = [];
    const closes: number[] = [];
    const channel = new ExperimentalWebSocketTakeoverChannel({
      ...accepted,
      peer: {
        sendControl(message) { controls.push(message); },
        sendFrame(frame) { frames.push(frame.data[0]!); },
        bufferedAmount() { return 0; },
        close(code) { closes.push(code); }
      },
      onInput(input) { inputs.push(input); return onInput?.(input); }
    });
    return { accepted, channel, controls, inputs, frames, closes };
  }
  return { sessions, locator, authority, ticket, completions, connect, setTime(value: number) { now = value; } };
}

const operations = {
  input: (channel: ExperimentalWebSocketTakeoverChannel) => channel.receiveText(TAP),
  frame: (channel: ExperimentalWebSocketTakeoverChannel) => channel.pushFrame(FRAME),
  ping: (channel: ExperimentalWebSocketTakeoverChannel) => channel.receiveText('{"kind":"ping"}')
};

for (const [name, operation] of Object.entries(operations)) {
  test(`WSS conformance: ${name} is fenced at the exact media lease deadline`, async () => {
    const h = harness();
    const client = h.connect();
    await client.channel.start();
    h.setTime(h.locator.expiresAt);
    await assert.rejects(operation(client.channel), { code: "stale_generation" });
    assert.deepEqual(client.inputs, []);
    assert.deepEqual(client.frames, []);
    assert.equal(client.controls.some((message) => message.kind === "pong"), false);
    assert.equal(client.channel.state, "failed");
    assert.deepEqual(h.completions, []);
    assert.throws(() => h.authority.accept(h.locator.id, h.ticket), { code: "TAKEOVER_FORBIDDEN" });
  });
}

test("WSS conformance: expired bootstrap cannot claim or mint new media authority", () => {
  const h = harness();
  h.setTime(h.locator.expiresAt);
  assert.throws(() => h.authority.accept(h.locator.id, h.ticket), { code: "TAKEOVER_FORBIDDEN" });
  assert.throws(() => h.authority.issueHandshakeTicket(h.locator.id, PRINCIPAL, POLICY), { code: "TAKEOVER_EXPIRED" });
  assert.deepEqual(h.completions, []);
});

test("WSS conformance: an already claimed channel can Done during completion-only grace", async () => {
  const h = harness();
  const client = h.connect();
  await client.channel.start();
  h.setTime(h.locator.expiresAt + 999);
  // Pruning handshake records must not erase the bounded completion authority held by this channel.
  assert.throws(() => h.authority.accept(h.locator.id, h.ticket), { code: "TAKEOVER_FORBIDDEN" });
  await client.channel.receiveText(DONE);
  await client.channel.receiveText(DONE);
  await client.channel.receiveText(TAP);
  await client.channel.pushFrame(FRAME);
  assert.equal(client.channel.state, "closed");
  assert.equal(h.completions.length, 1);
  assert.equal(h.completions[0]!.alreadyCompleted, false);
  assert.equal(h.sessions.isCompleted(h.locator.id, PRINCIPAL), true);
  assert.deepEqual(client.inputs, []);
  assert.deepEqual(client.frames, []);
});

test("WSS conformance: Done is rejected at the exact completion grace deadline", async () => {
  const h = harness();
  const client = h.connect();
  await client.channel.start();
  h.setTime(h.locator.expiresAt + 1_000);
  await assert.rejects(client.channel.receiveText(DONE), { code: "TAKEOVER_EXPIRED" });
  assert.equal(client.channel.state, "failed");
  assert.equal(client.controls.some((message) => message.kind === "closed"), false);
  assert.deepEqual(h.completions, []);
});

const staleOperations = { input: operations.input, frame: operations.frame, done: (channel: ExperimentalWebSocketTakeoverChannel) => channel.receiveText(DONE) };
for (const boundary of ["reconnect", "epoch"] as const) {
  for (const [name, operation] of Object.entries(staleOperations)) {
    test(`WSS conformance: stale ${name} after ${boundary} cannot mutate or release the successor`, async () => {
      const h = harness();
      const old = h.connect();
      await old.channel.start();
      let accepted: ExperimentalWebSocketAcceptedSession;
      if (boundary === "reconnect") {
        // Keep the old socket locally open, then rotate its idle generation through real authority.
        h.setTime(10_250);
        accepted = h.authority.accept(h.locator.id, h.ticket);
        assert.equal(accepted.binding.clientGeneration, 2);
      } else {
        const next = h.sessions.ensure("intervention", 5, PRINCIPAL);
        const ticket = h.authority.issueHandshakeTicket(next.id, PRINCIPAL, POLICY);
        accepted = h.authority.accept(next.id, ticket);
        assert.equal(accepted.binding.epoch, 5);
      }
      const next = h.connect(accepted);
      await next.channel.start();
      await assert.rejects(operation(old.channel), {
        code: name === "done" ? (boundary === "reconnect" ? "TAKEOVER_FORBIDDEN" : "TAKEOVER_NOT_FOUND") : "stale_generation"
      });
      await old.channel.disconnect();
      await old.channel.revoke();
      assert.deepEqual(old.inputs, []);
      assert.deepEqual(old.frames, []);
      assert.deepEqual(h.completions, []);
      // This also proves stale failure cleanup did not release the successor lease.
      await next.channel.receiveText(TAP);
      await next.channel.pushFrame(FRAME);
      assert.equal(next.inputs.length, 1);
      assert.deepEqual(next.frames, [7]);
      await next.channel.receiveText(DONE);
      assert.equal(h.completions.length, 1);
      assert.equal(h.completions[0]!.epoch, accepted.binding.epoch);
    });
  }
}

test("WSS conformance: in-flight input blocks idle reconnect and is not replayed after disconnect", { timeout: 5_000 }, async () => {
  const h = harness();
  const entered = deferred();
  const finish = deferred();
  const old = h.connect(undefined, async () => { entered.resolve(); await finish.promise; });
  await old.channel.start();
  const input = old.channel.receiveText(TAP);
  await entered.promise;
  h.setTime(10_250);
  try {
    assert.throws(() => h.authority.accept(h.locator.id, h.ticket), { code: "TAKEOVER_CLIENT_ACTIVE" });
  } finally {
    finish.resolve();
    await input;
  }
  await old.channel.disconnect();
  assert.deepEqual(h.completions, [], "disconnect is not Human Done");
  const next = h.connect();
  await next.channel.start();
  assert.equal(next.accepted.binding.clientGeneration, 2);
  assert.deepEqual(next.inputs, [], "accepted input is not replayed into the new channel");
  await old.channel.receiveText(TAP);
  assert.equal(old.inputs.length, 1);
  await next.channel.receiveText(TAP);
  assert.equal(next.inputs.length, 1);
  await next.channel.disconnect();
  assert.deepEqual(h.completions, []);
});

test("WSS conformance: completion observer failure cannot restore mutable authority", async () => {
  const observerFailure = new Error("synthetic completion observer failure");
  const h = harness((result) => {
    assert.equal(h.sessions.isCompleted(result.id, PRINCIPAL), true);
    assert.throws(() => h.sessions.validateLocator(result.id, PRINCIPAL), { code: "TAKEOVER_NOT_FOUND" });
    throw observerFailure;
  });
  const client = h.connect();
  await client.channel.start();
  await assert.rejects(client.channel.receiveText(DONE), (error) => error === observerFailure);
  await client.channel.receiveText(TAP);
  await client.channel.pushFrame(FRAME);
  await client.channel.disconnect();
  assert.deepEqual(client.inputs, []);
  assert.deepEqual(client.frames, []);
  assert.equal(h.completions.length, 1);
  assert.equal(h.sessions.isCompleted(h.locator.id, PRINCIPAL), true);
  assert.throws(() => h.authority.accept(h.locator.id, h.ticket), { code: "TAKEOVER_FORBIDDEN" });
});

for (const [name, operation] of Object.entries(staleOperations)) {
  test(`WSS conformance: authority revoke fences ${name} even while the local channel is open`, async () => {
    const h = harness();
    const client = h.connect();
    await client.channel.start();
    h.authority.revokeSession(h.locator.id);
    assert.equal(client.channel.state, "open");
    await assert.rejects(operation(client.channel), {
      code: name === "done" ? "TAKEOVER_NOT_FOUND" : "stale_generation"
    });
    assert.deepEqual(client.inputs, []);
    assert.deepEqual(client.frames, []);
    assert.deepEqual(h.completions, []);
    assert.throws(() => h.authority.accept(h.locator.id, h.ticket), { code: "TAKEOVER_FORBIDDEN" });
    await client.channel.disconnect();
  });
}

test("WSS conformance: expiry during accepted input fences queued input without replay", { timeout: 5_000 }, async () => {
  const h = harness();
  const entered = deferred();
  const finish = deferred();
  const client = h.connect(undefined, async () => { entered.resolve(); await finish.promise; });
  await client.channel.start();
  const acceptedInput = client.channel.receiveText(TAP);
  await entered.promise;
  const queuedInput = client.channel.receiveText(TAP);
  // Attach rejection observation before releasing the accepted callback; no timing-based polling.
  const rejectedInput = assert.rejects(queuedInput, { code: "stale_generation" });
  h.setTime(h.locator.expiresAt);
  finish.resolve();
  await acceptedInput;
  await rejectedInput;
  assert.equal(client.inputs.length, 1, "already dispatched input may finish; queued input must not start");
  await client.channel.receiveText(TAP);
  assert.equal(client.inputs.length, 1);
  assert.equal(client.channel.state, "failed");
  assert.deepEqual(h.completions, []);
});
