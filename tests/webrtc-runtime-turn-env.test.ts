import assert from "node:assert/strict";
import test from "node:test";
import {
  createDirectOnlyWebRtcRuntime,
  createRelayEnabledWebRtcRuntime
} from "../src/browser-takeover/webrtc-runtime-attempt.js";
import { SpawnedWebRtcRuntimeProvider } from "../src/browser-takeover/webrtc-runtime.js";

const NAMES = [
  "MCP_HANDOFF_CLOUDFLARE_TURN_KEY_ID",
  "MCP_HANDOFF_CLOUDFLARE_TURN_KEY_API_TOKEN",
  "MCP_HANDOFF_COTURN_SHARED_SECRET",
  "MCP_HANDOFF_COTURN_TURN_URLS",
  "MCP_HANDOFF_COTURN_STUN_URLS"
] as const;

function clear(): void { for (const name of NAMES) delete process.env[name]; }
function runtime(): SpawnedWebRtcRuntimeProvider {
  return new SpawnedWebRtcRuntimeProvider({ hostExecutable: process.execPath });
}
function binding() {
  return {
    takeoverSessionId: "turn-env-session", interventionId: "turn-env-intervention", epoch: 1,
    principalBinding: "turn-env-principal", clientBinding: "turn-env-client-binding-1234567890",
    clientGeneration: 1, expiresAt: Date.now() + 60_000
  };
}

test("direct-only runtime construction never observes or issues configured TURN credentials", async () => {
  const original = new Map(NAMES.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  try {
    clear();
    process.env.MCP_HANDOFF_CLOUDFLARE_TURN_KEY_ID = "configured-cloudflare-key";
    process.env.MCP_HANDOFF_CLOUDFLARE_TURN_KEY_API_TOKEN = "server-only-test-token";
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("direct-only must not call the relay provider");
    };

    const provider = createDirectOnlyWebRtcRuntime({ hostExecutable: process.execPath });
    assert.equal(process.env.MCP_HANDOFF_CLOUDFLARE_TURN_KEY_ID, "configured-cloudflare-key");
    assert.equal(process.env.MCP_HANDOFF_CLOUDFLARE_TURN_KEY_API_TOKEN, "server-only-test-token");

    const ice = await provider.prepare(binding());
    assert.equal(fetchCalls, 0);
    assert.equal(ice.relay, "disabled");
    assert.deepEqual(ice.iceServers, []);
    assert.deepEqual(provider.diagnosticsSnapshot(), { events: [] });
    await provider.revoke("turn-env-session");
  } finally {
    globalThis.fetch = originalFetch;
    clear();
    for (const [name, value] of original) if (value !== undefined) process.env[name] = value;
  }
});

test("relay-enabled runtime construction can still issue configured TURN credentials", async () => {
  const original = new Map(NAMES.map((name) => [name, process.env[name]]));
  try {
    clear();
    process.env.MCP_HANDOFF_COTURN_SHARED_SECRET = "0123456789abcdef0123456789abcdef";
    process.env.MCP_HANDOFF_COTURN_TURN_URLS = "turn:turn.example.test:3478?transport=udp";
    process.env.MCP_HANDOFF_COTURN_STUN_URLS = "stun:turn.example.test:3478";

    const provider = createRelayEnabledWebRtcRuntime({ hostExecutable: process.execPath });
    const ice = await provider.prepare(binding());
    assert.equal(ice.relay, "available");
    assert.equal(ice.iceServers.length, 2);
    assert.deepEqual(ice.iceServers[0], { urls: "stun:turn.example.test:3478" });
    await provider.revoke("turn-env-session");
  } finally {
    clear();
    for (const [name, value] of original) if (value !== undefined) process.env[name] = value;
  }
});

test("runtime selects coturn from complete env and fails closed on partial or conflicting TURN providers", async () => {
  const original = new Map(NAMES.map((name) => [name, process.env[name]]));
  try {
    clear();
    process.env.MCP_HANDOFF_COTURN_SHARED_SECRET = "0123456789abcdef0123456789abcdef";
    process.env.MCP_HANDOFF_COTURN_TURN_URLS = "turn:turn.example.test:3478?transport=udp, turns:turn.example.test:5349?transport=tcp";
    process.env.MCP_HANDOFF_COTURN_STUN_URLS = "stun:turn.example.test:3478";
    const provider = runtime();
    const ice = await provider.prepare(binding());
    assert.equal(ice.relay, "available");
    assert.equal(ice.iceServers.length, 2);
    assert.deepEqual(ice.iceServers[0], { urls: "stun:turn.example.test:3478" });
    await provider.revoke("turn-env-session");

    clear();
    process.env.MCP_HANDOFF_COTURN_SHARED_SECRET = "0123456789abcdef0123456789abcdef";
    assert.throws(() => runtime(), /coturn TURN configuration is incomplete/);

    clear();
    process.env.MCP_HANDOFF_COTURN_SHARED_SECRET = "0123456789abcdef0123456789abcdef";
    process.env.MCP_HANDOFF_COTURN_TURN_URLS = "turn:turn.example.test:3478";
    process.env.MCP_HANDOFF_CLOUDFLARE_TURN_KEY_ID = "configured-cloudflare-key";
    assert.throws(() => runtime(), /Multiple TURN providers are configured/);
  } finally {
    clear();
    for (const [name, value] of original) if (value !== undefined) process.env[name] = value;
  }
});


test("runtime preserves direct fallback while recording a bounded Cloudflare credential failure reason", async () => {
  const original = new Map(NAMES.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  try {
    clear();
    process.env.MCP_HANDOFF_CLOUDFLARE_TURN_KEY_ID = "configured-cloudflare-key";
    process.env.MCP_HANDOFF_CLOUDFLARE_TURN_KEY_API_TOKEN = "server-only-test-token";
    globalThis.fetch = async () => new Response(JSON.stringify({ sensitive: "must-not-surface" }), { status: 403 });
    const provider = runtime();
    const ice = await provider.prepare(binding());
    assert.equal(ice.relay, "unavailable");
    assert.deepEqual(ice.iceServers, []);
    assert.deepEqual(provider.diagnosticsSnapshot(), {
      events: [{ stage: "relay.credential.unavailable", reason: "provider_auth" }]
    });
    assert.doesNotMatch(JSON.stringify(provider.diagnosticsSnapshot()), /sensitive|server-only-test-token|configured-cloudflare-key/);
    await provider.revoke("turn-env-session");
  } finally {
    globalThis.fetch = originalFetch;
    clear();
    for (const [name, value] of original) if (value !== undefined) process.env[name] = value;
  }
});
