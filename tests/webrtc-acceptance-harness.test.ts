import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const harness = () => readFileSync("experiments/thin-takeover-runtime/scripts/webrtc-lan-acceptance.mts", "utf8");

test("canonical WebRTC acceptance harness keeps LAN direct and public relay on one target/runtime shape", () => {
  const source = harness();
  assert.match(source, /HANDOFF_ACCEPT_MODE/);
  assert.match(source, /public-relay/);
  assert.match(source, /HANDOFF_PUBLIC_ORIGIN/);
  assert.match(source, /BROKER_PORT = MODE === "public-relay" \? 18789 : 8877/);
  assert.match(source, /BROKER_HOST = MODE === "public-relay" \? "127\.0\.0\.1" : "0\.0\.0\.0"/);
  assert.match(source, /public-relay acceptance requires both Cloudflare TURN credential variables/);
  assert.match(source, /Refusing LAN direct acceptance while TURN credentials are present/);
  assert.match(source, /--new-window/);
  assert.doesNotMatch(source, /--app=file:/);
});

test("acceptance control endpoints require both loopback transport and loopback Host", () => {
  const source = harness();
  assert.match(source, /const loopbackSocket =/);
  assert.match(source, /const loopbackHost = host === `127\.0\.0\.1:\$\{BROKER_PORT\}`/);
  assert.match(source, /return loopbackSocket && loopbackHost/);
  assert.match(source, /if \(!localOnly\(req\)\)/);
});
