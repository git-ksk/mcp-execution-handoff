import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import {
  CloudflareRealtimeTurnCredentialProvider,
  CoturnRestTurnCredentialProvider,
  directOnlyIceSession,
  relayCredentialFailureReason,
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

test("direct-only keeps the browser host-only and makes the server STUN trust boundary explicit", async () => {
  const session = directOnlyIceSession();
  assert.equal(session.browser.relay, "disabled");
  assert.deepEqual(session.browser.iceServers, []);
  assert.deepEqual(session.serverIceServers, [{ urls: "stun:stun.cloudflare.com:3478" }]);
  assert.doesNotMatch(JSON.stringify(session.serverIceServers), /stun\.l\.google\.com/i);
  await session.revoke();
});

test("Cloudflare TURN adapter issues separate short-lived peer credentials and revokes both without identity tags", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let generation = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/credentials/generate")) {
      generation += 1;
      return new Response(JSON.stringify({
        iceServers: {
          urls: [
            "stun:stun.cloudflare.com:3478",
            "stun:stun.cloudflare.com:53",
            "turn:turn.cloudflare.com:3478?transport=udp",
            "turns:turn.cloudflare.com:5349?transport=tcp"
          ],
          username: randomBytes(18).toString("base64url"),
          credential: randomBytes(24).toString("base64url")
        }
      }), { status: 201, headers: { "content-type": "application/json" } });
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

  const generateRequests = requests.filter(({ url }) => url.endsWith("/credentials/generate"));
  assert.equal(generateRequests.length, 2);
  assert.equal(requests.some(({ url }) => url.includes("generate-ice-servers")), false);
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
    if (url.endsWith("/credentials/generate")) {
      generate += 1;
      if (generate === 1) {
        return new Response(JSON.stringify({
          iceServers: {
            urls: "turn:turn.cloudflare.com:3478?transport=udp",
            username: randomBytes(18).toString("base64url"),
            credential: randomBytes(24).toString("base64url")
          }
        }), { status: 201 });
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

  await assert.rejects(async () => {
    try {
      await provider.issue(binding());
    } catch (error) {
      assert.equal(relayCredentialFailureReason(error), "provider_unavailable");
      assert.doesNotMatch(String(error), /503|turn_key|credential|principal|session/i);
      throw error;
    }
  }, /TURN credential unavailable/);
  assert.equal(requests.filter((url) => url.endsWith("/revoke")).length, 1);
});


test("Cloudflare TURN adapter classifies provider failures without leaking response or secret material", async () => {
  const cases: Array<{ status?: number; throws?: boolean; body?: string; expected: string }> = [
    { status: 401, expected: "provider_auth" },
    { status: 403, expected: "provider_auth" },
    { status: 429, expected: "provider_rate_limited" },
    { status: 503, expected: "provider_unavailable" },
    { status: 404, expected: "provider_rejected" },
    { throws: true, expected: "provider_unavailable" },
    { status: 200, body: "not-json", expected: "response_invalid" }
  ];
  for (const scenario of cases) {
    const provider = new CloudflareRealtimeTurnCredentialProvider({
      turnKeyId: "turn_key_unit_123456",
      turnKeyApiToken: ["server", "unit", "credential"].join("-"),
      fetchImpl: async () => {
        if (scenario.throws) throw new Error("network included secret-shaped material");
        return new Response(scenario.body ?? "{}", { status: scenario.status ?? 200 });
      },
      now: () => 1_700_000_000_000
    });
    await assert.rejects(async () => {
      try {
        await provider.issue(binding());
      } catch (error) {
        assert.equal(relayCredentialFailureReason(error), scenario.expected);
        assert.equal(String(error), "WebRtcRelayCredentialError: TURN credential unavailable");
        throw error;
      }
    }, /TURN credential unavailable/);
  }
});


test("coturn REST adapter issues independent generation-bounded HMAC-SHA1 credentials without identity tags", async () => {
  const ids = ["browser_random_peer_123456", "server_random_peer_123456"];
  const secret = "0123456789abcdef0123456789abcdef";
  const provider = new CoturnRestTurnCredentialProvider({
    turnUrls: [
      "turn:turn.example.test:3478?transport=udp",
      "turns:turn.example.test:5349?transport=tcp"
    ],
    stunUrls: ["stun:turn.example.test:3478"],
    sharedSecret: secret,
    now: () => 1_700_000_000_000,
    randomId: () => ids.shift()!
  });

  const session = await provider.issue(binding());
  assert.equal(session.browser.relay, "available");
  assert.equal(session.browser.iceServers.length, 2);
  assert.equal(session.serverIceServers.length, 2);
  const browserTurn = session.browser.iceServers[1]!;
  const serverTurn = session.serverIceServers[1]!;
  assert.equal(browserTurn.username, "1700000060:browser_random_peer_123456");
  assert.equal(serverTurn.username, "1700000060:server_random_peer_123456");
  assert.notEqual(browserTurn.username, serverTurn.username);
  assert.deepEqual(browserTurn.urls, [
    "turn:turn.example.test:3478?transport=udp",
    "turns:turn.example.test:5349?transport=tcp"
  ]);
  assert.deepEqual(session.browser.iceServers[0], { urls: "stun:turn.example.test:3478" });
  assert.equal(browserTurn.credential, "CVhPNYLGD0hhpf1yLDzwF/gnS9c=");
  assert.equal(serverTurn.credential, "1reFC0HjdhXsdRUjCLgoEvlpShc=");
  assert.notEqual(browserTurn.credential, serverTurn.credential);
  assert.doesNotMatch(String(browserTurn.username), /principal|intervention|client|session/i);
  await session.revoke();
  await session.revoke();
});

test("coturn REST adapter rejects weak secrets, embedded credentials, expired generations, and duplicate peer ids", async () => {
  assert.throws(() => new CoturnRestTurnCredentialProvider({
    turnUrls: ["turn:turn.example.test:3478"],
    sharedSecret: "too-short"
  }), /coturn shared secret is invalid/);
  assert.throws(() => new CoturnRestTurnCredentialProvider({
    turnUrls: ["turn:user@turn.example.test:3478"],
    sharedSecret: "0123456789abcdef0123456789abcdef"
  }), /coturn turn URLs are invalid/);
  for (const invalidUrl of [
    "turn:turn.example.test:70000",
    "turn:turn.example.test:3478?credential=secret",
    "turn:turn.example.test:3478/path"
  ]) {
    assert.throws(() => new CoturnRestTurnCredentialProvider({
      turnUrls: [invalidUrl],
      sharedSecret: "0123456789abcdef0123456789abcdef"
    }), /coturn turn URLs are invalid/);
  }
  assert.throws(() => new CoturnRestTurnCredentialProvider({
    turnUrls: ["turn:turn.example.test:3478"],
    stunUrls: ["stun:turn.example.test:3478?transport=udp"],
    sharedSecret: "0123456789abcdef0123456789abcdef"
  }), /coturn stun URLs are invalid/);

  const expired = new CoturnRestTurnCredentialProvider({
    turnUrls: ["turn:turn.example.test:3478"],
    sharedSecret: "0123456789abcdef0123456789abcdef",
    now: () => binding().expiresAt
  });
  await assert.rejects(() => expired.issue(binding()), /WebRTC generation is expired/);

  const duplicate = new CoturnRestTurnCredentialProvider({
    turnUrls: ["turn:turn.example.test:3478"],
    sharedSecret: "0123456789abcdef0123456789abcdef",
    now: () => 1_700_000_000_000,
    randomId: () => "same_random_peer_123456"
  });
  await assert.rejects(() => duplicate.issue(binding()), /TURN credential issuance failed/);
});
