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
  assert.match(source, /WindowHandoffAdapter/);
  assert.match(source, /windowHandoff\.start/);
  assert.match(source, /inputPolicy: ACCEPTANCE_INPUT_POLICY/);
  assert.doesNotMatch(source, /new TakeoverBroker/);
  assert.doesNotMatch(source, /new SpawnedWebRtcRuntimeProvider/);
  assert.doesNotMatch(source, /--app=file:/);
});

test("acceptance control endpoints require both loopback transport and loopback Host", () => {
  const source = harness();
  assert.match(source, /const loopbackSocket =/);
  assert.match(source, /const loopbackHost = host === `127\.0\.0\.1:\$\{BROKER_PORT\}`/);
  assert.match(source, /return loopbackSocket && loopbackHost/);
  assert.match(source, /if \(!localOnly\(req\)\)/);
});

const coturnHarness = () => readFileSync("experiments/coturn-turn/scripts/relay-acceptance.mjs", "utf8");
const coturnContainerHarness = () => readFileSync("experiments/coturn-turn/scripts/container-acceptance.sh", "utf8");

test("coturn relay acceptance proves real relay use without exposing a host port", () => {
  const source = coturnHarness();
  const container = coturnContainerHarness();
  assert.match(source, /iceTransportPolicy: "relay"/);
  assert.match(source, /candidateTypes/);
  assert.match(source, /assert\.deepEqual\(\[\.\.\.candidateTypes\(caller\.localDescription\.sdp\)\], \["relay"\]\)/);
  assert.match(source, /COTURN_RELAY_ACCEPTANCE_PASS/);
  assert.doesNotMatch(source, /console\.log\([^\n]*(?:credential|sharedSecret|sdp)/i);

  assert.match(container, /--use-auth-secret/);
  assert.match(container, /--static-auth-secret="\$SECRET"/);
  assert.match(container, /coturn\/coturn@sha256:[a-f0-9]{64}/);
  assert.match(container, /node:22-bookworm-slim@sha256:[a-f0-9]{64}/);
  assert.match(container, /SUFFIX=\$\$/);
  assert.match(container, /docker network create/);
  assert.match(container, /Relay ports initialization done/);
  assert.doesNotMatch(container, /(?:^|\s)-p(?:\s|=)/m);
  assert.match(container, /umask 077/);
  assert.match(container, /mktemp/);
  assert.match(container, /rm -f "\$SECRET_FILE"/);
});
