import assert from "node:assert/strict";
import { RTCPeerConnection } from "werift";
import { CoturnRestTurnCredentialProvider } from "../../../dist/browser-takeover/webrtc-ice.js";

const turnUrl = process.env.HANDOFF_COTURN_TURN_URL?.trim();
const sharedSecret = process.env.MCP_HANDOFF_COTURN_SHARED_SECRET?.trim();
if (!turnUrl) throw new Error("HANDOFF_COTURN_TURN_URL is required");
if (!sharedSecret) throw new Error("MCP_HANDOFF_COTURN_SHARED_SECRET is required");

function stage(name) {
  process.stdout.write(`COTURN_ACCEPT_STAGE ${name}\n`);
}

async function waitFor(label, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`coturn relay acceptance timed out at ${label}`);
}

function candidateTypes(sdp) {
  const values = new Set();
  for (const line of sdp.split(/\r?\n/)) {
    if (!line.startsWith("a=candidate:")) continue;
    const match = /\styp\s+(host|srflx|prflx|relay)(?:\s|$)/.exec(line);
    if (match) values.add(match[1]);
  }
  return values;
}

const provider = new CoturnRestTurnCredentialProvider({
  turnUrls: [turnUrl],
  sharedSecret
});
const binding = {
  takeoverSessionId: "coturn-relay-acceptance",
  interventionId: "coturn-relay-acceptance",
  epoch: 1,
  principalBinding: "coturn-relay-acceptance",
  clientBinding: "coturn-relay-acceptance-client-binding",
  clientGeneration: 1,
  expiresAt: Date.now() + 60_000
};

const ice = await provider.issue(binding);
stage("credentials");

const caller = new RTCPeerConnection({
  iceServers: ice.browser.iceServers,
  iceTransportPolicy: "relay",
  maxMessageSize: 4096
});
const callee = new RTCPeerConnection({
  iceServers: ice.serverIceServers,
  iceTransportPolicy: "relay",
  maxMessageSize: 4096
});
const outbound = caller.createDataChannel("acceptance", { ordered: true });
let inbound;
let receivedBytes = 0;
callee.onDataChannel.subscribe((channel) => {
  inbound = channel;
  channel.onMessage.subscribe((message) => {
    receivedBytes += Buffer.byteLength(String(message), "utf8");
  });
});

try {
  const offer = await caller.createOffer();
  await caller.setLocalDescription(offer);
  assert.ok(caller.localDescription?.sdp, "caller local SDP is required");
  assert.deepEqual([...candidateTypes(caller.localDescription.sdp)], ["relay"]);

  await callee.setRemoteDescription(caller.localDescription);
  const answer = await callee.createAnswer();
  await callee.setLocalDescription(answer);
  assert.ok(callee.localDescription?.sdp, "callee local SDP is required");
  assert.deepEqual([...candidateTypes(callee.localDescription.sdp)], ["relay"]);
  stage("relay-candidates");

  await caller.setRemoteDescription(callee.localDescription);
  await waitFor("connected", () => caller.connectionState === "connected" && callee.connectionState === "connected");
  stage("connected");

  await waitFor("datachannel-open", () => outbound.readyState === "open" && inbound?.readyState === "open");
  const probe = "handoff-coturn-relay-acceptance";
  outbound.send(probe);
  await waitFor("datachannel-message", () => receivedBytes === Buffer.byteLength(probe, "utf8"));
  stage("datachannel");
  process.stdout.write("COTURN_RELAY_ACCEPTANCE_PASS\n");
} finally {
  await Promise.allSettled([caller.close(), callee.close()]);
  await ice.revoke();
}

// Werift may retain TURN transaction timers after a clean peer close. This is an
// acceptance executable, so terminate only after all assertions and cleanup complete.
process.exit(0);
