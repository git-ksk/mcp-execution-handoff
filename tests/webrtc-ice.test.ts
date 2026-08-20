import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import {
  CloudflareRealtimeTurnCredentialProvider,
  type WebRtcTakeoverRuntimeBinding
} from "../src/browser-takeover/webrtc-ice.js";

function binding(): WebRtcTakeoverRuntimeBinding {
  return {
    takeoverSessionId: "session-turn-test",
    interventionId: "intervention-turn-test",
    epoch: 9,
    principalBinding: "principal-turn-test",
    clientBinding: "client-turn-test-1234567890",
    clientGeneration: 4,
    expiresAt: 1_700_000_060_000
  };
}

test("Cloudflare TURN adapter issues separate short-lived peer credentials and revokes both without identity tags", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let generation = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.includes("generate-ice-servers")) {
      generation += 1;
      return new Response(JSON.stringify({
        iceServers: [
          { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
          {
            urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:5349?transport=tcp"],
            username: randomBytes(18).toString("base64url"),
            credential: randomBytes(24).toString("base64url")
          }
        ]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/revoke")) return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  };
  const token = ["server", "only", "unit", "token"].join("-");
  const provider = new CloudflareRealtimeTurnCredentialProvider({
    turnKeyId: "turn_key_unit_123456",
    turnKeyApiToken: token,
    fetchImpl: fakeFetch,
    now: () => 1_700_000_000_000
  });

  const session = await provider.issue(binding());
  assert.equal(session.browser.relay, "available");
  assert.equal(session.browser.iceServers.length, 2);
  assert.equal(session.serverIceServers.length, 2);
  assert.notEqual(session.browser.iceServers[1]!.username, session.serverIceServers[1]!.username);
  const browserUrls = session.browser.iceServers.flatMap((server) =>
    Array.isArray(server.urls) ? server.urls : [server.urls]
  );
  const serverUrls = session.serverIceServers.flatMap((server) =>
    Array.isArray(server.urls) ? server.urls : [server.urls]
  );
  assert.equal(browserUrls.includes("stun:stun.cloudflare.com:53"), false);
  assert.equal(serverUrls.includes("stun:stun.cloudflare.com:53"), true);

  const generateRequests = requests.filter(({ url }) => url.includes("generate-ice-servers"));
  assert.equal(generateRequests.length, 2);
  for (const request of generateRequests) {
    const body = JSON.parse(String(request.init?.body)) as Record<string, unknown>;
    assert.deepEqual(body, { ttl: 60 });
    assert.equal("customIdentifier" in body, false);
    assert.equal((request.init?.headers as Record<string, string>).authorization, `Bearer ${token}`);
    assert.doesNotMatch(String(request.init?.body), /principal|intervention|client|session/i);
  }

  await session.revoke();
  await session.revoke();
  const revokeRequests = requests.filter(({ url }) => url.endsWith("/revoke"));
  assert.equal(revokeRequests.length, 2);
});

test("Cloudflare TURN adapter fails generically and revokes partial issuance", async () => {
  const requests: string[] = [];
  let generate = 0;
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("generate-ice-servers")) {
      generate += 1;
      if (generate === 1) {
        return new Response(JSON.stringify({
          iceServers: [{
            urls: "turn:turn.cloudflare.com:3478?transport=udp",
            username: randomBytes(18).toString("base64url"),
            credential: randomBytes(24).toString("base64url")
          }]
        }), { status: 200 });
      }
      return new Response(null, { status: 503 });
    }
    if (url.endsWith("/revoke")) return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  };
  const provider = new CloudflareRealtimeTurnCredentialProvider({
    turnKeyId: "turn_key_unit_123456",
    turnKeyApiToken: ["server", "unit", "credential"].join("-"),
    fetchImpl: fakeFetch,
    now: () => 1_700_000_000_000
  });

  await assert.rejects(() => provider.issue(binding()), /^Error: TURN credential issuance failed$/);
  assert.equal(requests.filter((url) => url.endsWith("/revoke")).length, 1);
});
