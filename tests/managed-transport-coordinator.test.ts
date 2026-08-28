import assert from "node:assert/strict";
import test from "node:test";
import {
  ManagedBrowserHandoffTransportCoordinator,
  ManagedBrowserHandoffTransportCoordinatorError,
  type ManagedBrowserHandoffTransportDriver
} from "../src/browser-takeover/managed-transport-coordinator.js";
import type { BrowserHandoffTransportAttempt } from "../src/browser-takeover/transport-fallback-policy.js";

function driver(
  kind: BrowserHandoffTransportAttempt,
  events: string[],
  hooks: {
    start?: (generation: number) => string | Promise<string>;
    revoke?: () => void | Promise<void>;
  } = {}
): ManagedBrowserHandoffTransportDriver {
  return {
    kind,
    async start(generation) {
      events.push(`start:${kind}:${generation}`);
      return hooks.start ? hooks.start(generation) : `https://takeover.example/${kind}/${generation}`;
    },
    async revoke() {
      events.push(`revoke:${kind}`);
      await hooks.revoke?.();
    }
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("managed coordinator enforces direct -> WSS -> optional TURN plan", async () => {
  const events: string[] = [];
  const coordinator = new ManagedBrowserHandoffTransportCoordinator(
    { websocketRelayEnabled: true, webrtcRelayEnabled: true },
    [
      driver("webrtc_direct", events),
      driver("websocket_relay", events),
      driver("webrtc_relay", events)
    ]
  );

  const direct = await coordinator.start();
  assert.deepEqual(direct, {
    transport: "webrtc_direct",
    generation: 1,
    locator: "https://takeover.example/webrtc_direct/1"
  });
  const wss = await coordinator.advance(direct);
  assert.deepEqual(wss, {
    transport: "websocket_relay",
    generation: 2,
    locator: "https://takeover.example/websocket_relay/2"
  });
  const turn = await coordinator.advance(wss!);
  assert.deepEqual(turn, {
    transport: "webrtc_relay",
    generation: 3,
    locator: "https://takeover.example/webrtc_relay/3"
  });
  assert.deepEqual(events, [
    "start:webrtc_direct:1",
    "revoke:webrtc_direct",
    "start:websocket_relay:2",
    "revoke:websocket_relay",
    "start:webrtc_relay:3"
  ]);
});

test("managed coordinator never starts the next transport before revoke resolves", async () => {
  const events: string[] = [];
  const gate = deferred();
  const coordinator = new ManagedBrowserHandoffTransportCoordinator(
    { websocketRelayEnabled: true, webrtcRelayEnabled: false },
    [
      driver("webrtc_direct", events, { revoke: () => gate.promise }),
      driver("websocket_relay", events)
    ]
  );

  const direct = await coordinator.start();
  const transition = coordinator.advance(direct);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["start:webrtc_direct:1", "revoke:webrtc_direct"]);
  assert.equal(coordinator.snapshot()?.transport, "webrtc_direct");

  gate.resolve();
  const wss = await transition;
  assert.equal(wss?.transport, "websocket_relay");
  assert.deepEqual(events, [
    "start:webrtc_direct:1",
    "revoke:webrtc_direct",
    "start:websocket_relay:2"
  ]);
});

test("concurrent fallback requests have one winner and stale generation fails closed", async () => {
  const events: string[] = [];
  const coordinator = new ManagedBrowserHandoffTransportCoordinator(
    { websocketRelayEnabled: true, webrtcRelayEnabled: true },
    [
      driver("webrtc_direct", events),
      driver("websocket_relay", events),
      driver("webrtc_relay", events)
    ]
  );

  const direct = await coordinator.start();
  const first = coordinator.advance(direct);
  const stale = coordinator.advance(direct);
  const wss = await first;
  assert.equal(wss?.transport, "websocket_relay");
  await assert.rejects(stale, (error: unknown) => {
    assert.ok(error instanceof ManagedBrowserHandoffTransportCoordinatorError);
    assert.equal(error.code, "MANAGED_TRANSPORT_STALE");
    return true;
  });
  assert.deepEqual(events, [
    "start:webrtc_direct:1",
    "revoke:webrtc_direct",
    "start:websocket_relay:2"
  ]);
});

test("TURN is unreachable when the managed policy disables WebRTC relay", async () => {
  const events: string[] = [];
  const coordinator = new ManagedBrowserHandoffTransportCoordinator(
    { websocketRelayEnabled: true, webrtcRelayEnabled: false },
    [driver("webrtc_direct", events), driver("websocket_relay", events)]
  );

  const direct = await coordinator.start();
  const wss = await coordinator.advance(direct);
  const exhausted = await coordinator.advance(wss!);
  assert.equal(exhausted, undefined);
  assert.equal(coordinator.snapshot(), undefined);
  assert.deepEqual(events, [
    "start:webrtc_direct:1",
    "revoke:webrtc_direct",
    "start:websocket_relay:2",
    "revoke:websocket_relay"
  ]);
});

test("invalid provider order is rejected before any transport can claim authority", () => {
  const events: string[] = [];
  assert.throws(
    () => new ManagedBrowserHandoffTransportCoordinator(
      { websocketRelayEnabled: true, webrtcRelayEnabled: true },
      [
        driver("webrtc_direct", events),
        driver("webrtc_relay", events),
        driver("websocket_relay", events)
      ]
    ),
    (error: unknown) => {
      assert.ok(error instanceof ManagedBrowserHandoffTransportCoordinatorError);
      assert.equal(error.code, "MANAGED_TRANSPORT_PLAN_INVALID");
      return true;
    }
  );
  assert.deepEqual(events, []);
});

test("failed next transport is cleaned up and never becomes active", async () => {
  const events: string[] = [];
  const coordinator = new ManagedBrowserHandoffTransportCoordinator(
    { websocketRelayEnabled: true, webrtcRelayEnabled: false },
    [
      driver("webrtc_direct", events),
      driver("websocket_relay", events, {
        start: () => { throw new Error("relay unavailable"); }
      })
    ]
  );

  const direct = await coordinator.start();
  await assert.rejects(coordinator.advance(direct), /relay unavailable/);
  assert.equal(coordinator.snapshot(), undefined);
  assert.deepEqual(events, [
    "start:webrtc_direct:1",
    "revoke:webrtc_direct",
    "start:websocket_relay:2",
    "revoke:websocket_relay"
  ]);
});
