import assert from "node:assert/strict";
import test from "node:test";
import { TakeoverSessionError, TakeoverSessionManager } from "../src/browser-takeover/session.js";

const PRINCIPAL_A = "principal-a";
const PRINCIPAL_B = "principal-b";
const CLIENT_A = "client-binding-a-1234567890";
const CLIENT_B = "client-binding-b-1234567890";

function manager() {
  let now = 1_000;
  let id = 0;
  return {
    sessions: new TakeoverSessionManager(
      60_000,
      () => now,
      () => `takeover-${++id}`,
      Buffer.alloc(32, 7)
    ),
    advance(ms: number) {
      now += ms;
    }
  };
}

test("one remote client owns the capability for an intervention epoch", () => {
  const { sessions } = manager();
  const first = sessions.ensure("intervention-a", 4, PRINCIPAL_A);
  const repeated = sessions.ensure("intervention-a", 4, PRINCIPAL_A);

  assert.equal(first.id, repeated.id);
  assert.equal(first.expiresAt, repeated.expiresAt);
  sessions.validateLocator(first.id, PRINCIPAL_A);

  const grant = sessions.claimClient(first.id, PRINCIPAL_A, CLIENT_A);
  const reload = sessions.claimClient(first.id, PRINCIPAL_A, CLIENT_A);
  assert.equal(grant.capability, reload.capability);
  assert.equal(grant.clientBinding, CLIENT_A);
  assert.deepEqual(sessions.verify(first.id, grant.capability, PRINCIPAL_A, CLIENT_A), {
    id: first.id,
    interventionId: "intervention-a",
    epoch: 4,
    principalBinding: PRINCIPAL_A,
    expiresAt: first.expiresAt,
    clientBinding: CLIENT_A,
    clientGeneration: 1
  });

  assert.throws(
    () => sessions.claimClient(first.id, PRINCIPAL_A, CLIENT_B),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_FORBIDDEN"
  );
  assert.throws(
    () => sessions.verify(first.id, grant.capability, PRINCIPAL_A, CLIENT_B),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_FORBIDDEN"
  );
  assert.throws(
    () => sessions.verify(first.id, grant.capability, PRINCIPAL_B, CLIENT_A),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_FORBIDDEN"
  );
  assert.throws(
    () => sessions.verify(first.id, `${grant.capability}x`, PRINCIPAL_A, CLIENT_A),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_FORBIDDEN"
  );
});

test("new resource epoch rotates takeover session and resets the client lease", () => {
  const { sessions } = manager();
  const first = sessions.ensure("intervention-a", 4, PRINCIPAL_A);
  const firstGrant = sessions.claimClient(first.id, PRINCIPAL_A, CLIENT_A);
  const second = sessions.ensure("intervention-a", 5, PRINCIPAL_A);
  const secondGrant = sessions.claimClient(second.id, PRINCIPAL_A, CLIENT_B);

  assert.notEqual(second.id, first.id);
  assert.notEqual(secondGrant.capability, firstGrant.capability);
  assert.equal(secondGrant.clientBinding, CLIENT_B);
  assert.throws(
    () => sessions.verify(first.id, firstGrant.capability, PRINCIPAL_A, CLIENT_A),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_NOT_FOUND"
  );
  assert.equal(sessions.verify(second.id, secondGrant.capability, PRINCIPAL_A, CLIENT_B).epoch, 5);
});

test("takeover capability expires and a fresh media lease does not revoke old completion-only grace", () => {
  const { sessions, advance } = manager();
  const locator = sessions.ensure("intervention-a", 1, PRINCIPAL_A);
  const completion = sessions.issueCompletionCapability(locator.id, PRINCIPAL_A);
  const grant = sessions.claimClient(locator.id, PRINCIPAL_A, CLIENT_A);
  advance(60_001);
  assert.throws(
    () => sessions.verify(grant.id, grant.capability, PRINCIPAL_A, CLIENT_A),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_EXPIRED"
  );

  const replacement = sessions.ensure("intervention-a", 1, PRINCIPAL_A);
  assert.notEqual(replacement.id, locator.id);
  const replacementGrant = sessions.claimClient(replacement.id, PRINCIPAL_A, CLIENT_A);
  assert.equal(sessions.complete(locator.id, completion, PRINCIPAL_A).alreadyCompleted, false);

  sessions.revokeForIntervention("intervention-a");
  assert.throws(
    () => sessions.verify(replacementGrant.id, replacementGrant.capability, PRINCIPAL_A, CLIENT_A),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_NOT_FOUND"
  );
});

test("completion-only capability survives a released media generation without reviving it", () => {
  const { sessions } = manager();
  const locator = sessions.ensure("intervention-complete", 9, PRINCIPAL_A);
  const completion = sessions.issueCompletionCapability(locator.id, PRINCIPAL_A);
  const grant = sessions.claimClient(locator.id, PRINCIPAL_A, CLIENT_A);
  sessions.releaseClientGeneration(locator.id, PRINCIPAL_A, CLIENT_A, grant.clientGeneration);

  assert.throws(
    () => sessions.verify(locator.id, grant.capability, PRINCIPAL_A, CLIENT_A),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_FORBIDDEN"
  );
  assert.throws(
    () => sessions.complete(locator.id, completion, PRINCIPAL_B),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_FORBIDDEN"
  );
  assert.throws(
    () => sessions.complete(locator.id, "x".repeat(43), PRINCIPAL_A),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_FORBIDDEN"
  );

  const first = sessions.complete(locator.id, completion, PRINCIPAL_A);
  assert.equal(first.alreadyCompleted, false);
  const duplicate = sessions.complete(locator.id, completion, PRINCIPAL_A);
  assert.equal(duplicate.alreadyCompleted, true);
  assert.throws(
    () => sessions.verify(locator.id, grant.capability, PRINCIPAL_A, CLIENT_A),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_NOT_FOUND"
  );
});

test("completion-only capability fails closed after explicit revoke or expiry", () => {
  const { sessions, advance } = manager();
  const revoked = sessions.ensure("intervention-revoked", 1, PRINCIPAL_A);
  const revokedCompletion = sessions.issueCompletionCapability(revoked.id, PRINCIPAL_A);
  sessions.revoke(revoked.id);
  assert.throws(
    () => sessions.complete(revoked.id, revokedCompletion, PRINCIPAL_A),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_NOT_FOUND"
  );

  const expired = sessions.ensure("intervention-expired", 1, PRINCIPAL_A);
  const expiredCompletion = sessions.issueCompletionCapability(expired.id, PRINCIPAL_A);
  advance(60_001);
  assert.throws(
    () => sessions.complete(expired.id, expiredCompletion, PRINCIPAL_A),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_EXPIRED"
  );
});

test("claimed Human session loses input at ttl but keeps completion-only grace", () => {
  const { sessions, advance } = manager();
  const locator = sessions.ensure("intervention-human-active", 9, PRINCIPAL_A);
  const completion = sessions.issueCompletionCapability(locator.id, PRINCIPAL_A);
  const grant = sessions.claimClient(locator.id, PRINCIPAL_A, CLIENT_A);

  advance(60_001);
  assert.throws(
    () => sessions.verify(locator.id, grant.capability, PRINCIPAL_A, CLIENT_A),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_EXPIRED"
  );
  assert.equal(sessions.issueCompletionCapability(locator.id, PRINCIPAL_A), completion);
  assert.equal(sessions.complete(locator.id, completion, PRINCIPAL_A).alreadyCompleted, false);
});

test("claimed Human completion grace is bounded and explicit revoke still wins", () => {
  const { sessions, advance } = manager();
  const locator = sessions.ensure("intervention-human-active", 10, PRINCIPAL_A);
  const completion = sessions.issueCompletionCapability(locator.id, PRINCIPAL_A);
  sessions.claimClient(locator.id, PRINCIPAL_A, CLIENT_A);
  advance(120_001);
  assert.throws(
    () => sessions.complete(locator.id, completion, PRINCIPAL_A),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_EXPIRED"
  );

  const revoked = sessions.ensure("intervention-human-revoked", 11, PRINCIPAL_A);
  const revokedCompletion = sessions.issueCompletionCapability(revoked.id, PRINCIPAL_A);
  sessions.claimClient(revoked.id, PRINCIPAL_A, CLIENT_A);
  sessions.revoke(revoked.id);
  assert.throws(
    () => sessions.complete(revoked.id, revokedCompletion, PRINCIPAL_A),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_NOT_FOUND"
  );
});

test("invalid client binding never claims a lease", () => {
  const { sessions } = manager();
  const locator = sessions.ensure("intervention-a", 1, PRINCIPAL_A);
  assert.throws(
    () => sessions.claimClient(locator.id, PRINCIPAL_A, "short"),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_FORBIDDEN"
  );
  const grant = sessions.claimClient(locator.id, PRINCIPAL_A, CLIENT_B);
  assert.equal(grant.clientBinding, CLIENT_B);
});


test("explicit reconnect rotates the client generation only after the prior lease is idle", () => {
  const { sessions, advance } = manager();
  const locator = sessions.ensure("intervention-a", 3, PRINCIPAL_A);
  const first = sessions.claimClient(locator.id, PRINCIPAL_A, CLIENT_A);
  assert.equal(first.clientGeneration, 1);
  assert.match(first.reconnectHandle, /^[A-Za-z0-9_-]{32,128}$/);

  assert.throws(
    () => sessions.reconnectClient(locator.id, PRINCIPAL_A, first.reconnectHandle, CLIENT_B),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_CLIENT_ACTIVE"
  );

  advance(5_000);
  const second = sessions.reconnectClient(locator.id, PRINCIPAL_A, first.reconnectHandle, CLIENT_B);
  assert.equal(second.clientGeneration, 2);
  assert.equal(second.clientBinding, CLIENT_B);
  assert.notEqual(second.capability, first.capability);
  assert.notEqual(second.reconnectHandle, first.reconnectHandle);

  assert.throws(
    () => sessions.verify(locator.id, first.capability, PRINCIPAL_A, CLIENT_A),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_FORBIDDEN"
  );
  assert.throws(
    () => sessions.verify(locator.id, first.capability, PRINCIPAL_A, CLIENT_B),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_FORBIDDEN"
  );
  assert.equal(sessions.verify(locator.id, second.capability, PRINCIPAL_A, CLIENT_B).clientGeneration, 2);

  advance(5_000);
  assert.throws(
    () => sessions.reconnectClient(locator.id, PRINCIPAL_A, first.reconnectHandle, CLIENT_A),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_FORBIDDEN"
  );
});

test("reconnect rejects wrong principal, invalid handle, expiry and revocation", () => {
  const { sessions, advance } = manager();
  const locator = sessions.ensure("intervention-a", 3, PRINCIPAL_A);
  const first = sessions.claimClient(locator.id, PRINCIPAL_A, CLIENT_A);
  advance(5_000);

  assert.throws(
    () => sessions.reconnectClient(locator.id, PRINCIPAL_B, first.reconnectHandle, CLIENT_B),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_FORBIDDEN"
  );
  assert.throws(
    () => sessions.reconnectClient(locator.id, PRINCIPAL_A, "x".repeat(43), CLIENT_B),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_FORBIDDEN"
  );

  sessions.revoke(locator.id);
  assert.throws(
    () => sessions.reconnectClient(locator.id, PRINCIPAL_A, first.reconnectHandle, CLIENT_B),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_NOT_FOUND"
  );

  const replacement = sessions.ensure("intervention-b", 1, PRINCIPAL_A);
  const replacementGrant = sessions.claimClient(replacement.id, PRINCIPAL_A, CLIENT_A);
  advance(60_001);
  assert.throws(
    () => sessions.reconnectClient(replacement.id, PRINCIPAL_A, replacementGrant.reconnectHandle, CLIENT_B),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_EXPIRED"
  );
});

test("in-flight Human operation blocks reconnect and idle time starts after the operation ends", () => {
  const { sessions, advance } = manager();
  const locator = sessions.ensure("intervention-a", 8, PRINCIPAL_A);
  const first = sessions.claimClient(locator.id, PRINCIPAL_A, CLIENT_A);
  const use = sessions.beginUse(locator.id, first.capability, PRINCIPAL_A, CLIENT_A);

  advance(10_000);
  assert.throws(
    () => sessions.reconnectClient(locator.id, PRINCIPAL_A, first.reconnectHandle, CLIENT_B),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_CLIENT_ACTIVE"
  );

  sessions.endUse(locator.id, PRINCIPAL_A, CLIENT_A, use.clientGeneration);
  advance(4_999);
  assert.throws(
    () => sessions.reconnectClient(locator.id, PRINCIPAL_A, first.reconnectHandle, CLIENT_B),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_CLIENT_ACTIVE"
  );
  advance(1);
  const recovered = sessions.reconnectClient(locator.id, PRINCIPAL_A, first.reconnectHandle, CLIENT_B);
  assert.equal(recovered.clientGeneration, 2);
});

test("minimum takeover ttl keeps a valid reconnect idle default", () => {
  assert.doesNotThrow(() => new TakeoverSessionManager(1_000));
});

test("verified consumer completion fences only the exact intervention epoch", () => {
  const { sessions } = manager();
  const first = sessions.ensure("intervention-verified", 1, PRINCIPAL_A);
  const second = sessions.ensure("intervention-verified", 2, PRINCIPAL_A);

  assert.deepEqual(sessions.completeAfterVerification("intervention-verified", 1), []);
  const completed = sessions.completeAfterVerification("intervention-verified", 2);
  assert.equal(completed.length, 1);
  assert.equal(completed[0]!.id, second.id);
  assert.equal(completed[0]!.alreadyCompleted, false);
  assert.equal(sessions.isCompleted(second.id, PRINCIPAL_A), true);
  assert.equal(sessions.completeAfterVerification("intervention-verified", 2)[0]!.alreadyCompleted, true);
  assert.throws(
    () => sessions.validateLocator(first.id, PRINCIPAL_A),
    (error: unknown) => error instanceof TakeoverSessionError && error.code === "TAKEOVER_NOT_FOUND"
  );
});
