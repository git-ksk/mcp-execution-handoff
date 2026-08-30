import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { ManagedWindowHandoffRuntime } from "../src/browser-takeover/managed-handoff-runtime.js";

const ORIGIN = "https://takeover.example";
const PRINCIPAL = "managed-principal";
const RELAY_ENV = [
  "MCP_HANDOFF_CLOUDFLARE_TURN_KEY_ID",
  "MCP_HANDOFF_CLOUDFLARE_TURN_KEY_API_TOKEN",
  "MCP_HANDOFF_COTURN_SHARED_SECRET",
  "MCP_HANDOFF_COTURN_TURN_URLS",
  "MCP_HANDOFF_COTURN_STUN_URLS"
] as const;

function fixture(onManagedOperatorDiagnosticEvent?: (event: { kind: string }) => void) {
  return new ManagedWindowHandoffRuntime({
    takeover: { enabled: true, publicBaseUrl: ORIGIN, ttlMs: 60_000, reconnectIdleMs: 500 },
    runtime: { hostExecutable: process.execPath },
    managedFallback: { platform: "linux", linuxHostScript: process.execPath, displayName: ":99" },
    ...(onManagedOperatorDiagnosticEvent ? { onManagedOperatorDiagnosticEvent } : {})
  });
}

function request() {
  return {
    intervention: { id: "managed-int", epoch: 1 },
    principalBinding: PRINCIPAL,
    target: { processId: 4242, windowId: 7331 },
    inputPolicy: { tap: true, scroll: true, text: true, key: true }
  } as const;
}

function sessionId(locator: string): string {
  return new URL(locator).pathname.split("/").at(-1)!;
}

async function fallbackCapability(runtime: ManagedWindowHandoffRuntime, locator: string): Promise<string> {
  const response = await runtime.handle(new Request(locator), PRINCIPAL);
  assert.equal(response.status, 200);
  const html = await response.text();
  const value = /data-fallback="([A-Za-z0-9_-]{32,128})"/.exec(html)?.[1];
  assert.ok(value);
  return value;
}

function fallbackRequest(id: string, capability: string): Request {
  return new Request(`${ORIGIN}/takeover/api/transport-fallback/${id}`, {
    method: "POST",
    headers: { origin: ORIGIN, "x-mcp-handoff-fallback": capability }
  });
}

function saveRelayEnv(): Map<string, string | undefined> {
  return new Map(RELAY_ENV.map((name) => [name, process.env[name]]));
}

function clearRelayEnv(): void {
  for (const name of RELAY_ENV) delete process.env[name];
}

function restoreRelayEnv(saved: Map<string, string | undefined>): void {
  clearRelayEnv();
  for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
}

test("managed facade fences direct WebRTC before issuing a fresh WSS locator", async () => {
  const saved = saveRelayEnv();
  try {
    clearRelayEnv();
    const observed: Array<{ kind: string }> = [];
    const runtime = fixture((event) => observed.push(event));
    const direct = runtime.start(request());
    const directId = sessionId(direct);
    const capability = await fallbackCapability(runtime, direct);

    const client = await runtime.handle(
      new Request(`${ORIGIN}/takeover/webrtc-client.js`),
      PRINCIPAL
    );
    assert.equal(client.status, 200);
    const clientScript = await client.text();
    assert.match(clientScript, /managedTransportFallback/);
    assert.match(clientScript, /armManagedReadyTimeout\(\)/);
    assert.match(clientScript, /setTimeout\(\(\)=>\{managedReadyTimer=0;if\(!stopped\)void managedTransportFallback\(\)\},4000\)/);
    assert.match(clientScript, /clearManagedReadyTimeout\(\);clearFirstFrameTimer\(\)/);

    const moved = await runtime.handle(fallbackRequest(directId, capability), PRINCIPAL);
    assert.equal(moved.status, 200);
    const body = await moved.json() as { path: string };
    assert.notEqual(body.path, new URL(direct).pathname);

    const stalePage = await runtime.handle(new Request(direct), PRINCIPAL);
    assert.equal(stalePage.status, 404);
    const staleFallback = await runtime.handle(fallbackRequest(directId, capability), PRINCIPAL);
    assert.equal(staleFallback.status, 404);

    const wssPage = await runtime.handle(new Request(`${ORIGIN}${body.path}`), PRINCIPAL);
    assert.equal(wssPage.status, 200);
    const wssHtml = await wssPage.text();
    assert.match(wssHtml, /<img id="frame"/);
    assert.match(wssHtml, /managedTransportFallback/);
    assert.match(wssHtml, /managedWebSocketDisconnected/);
    assert.match(wssHtml, /managedReconnectAttempts=0/);
    assert.match(wssHtml, /managedReconnectLimit=4/);
    assert.match(wssHtml, /managedReconnectWindowMs=8000/);
    assert.match(wssHtml, /managedReconnectStableMs=1500/);
    assert.match(wssHtml, /managedWebSocketReady\(\)/);
    assert.match(wssHtml, /client_reconnect_ready/);
    assert.match(wssHtml, /client_reconnect_frame/);
    assert.match(wssHtml, /managedWebSocketFrameLoaded/);
    const wssScript = wssHtml.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)?.[1];
    assert.ok(wssScript);
    assert.doesNotThrow(() => new vm.Script(wssScript));
    assert.match(wssHtml, /600\+200\*\(managedReconnectAttempts-1\)/);
    assert.match(wssHtml, /event\.code===1008\|\|event\.code===1011/);
    assert.match(wssHtml, /setStatus\('Reconnecting…'\)/);
    assert.match(wssHtml, /if\(Date\.now\(\)>=managedReconnectDeadline\)\{void managedTransportFallback\(\);return\}armManagedReadyTimeout\(\)/);
    assert.match(wssHtml, /managedReconnectAttempts=0;managedReconnectDeadline=0/);
    assert.match(wssHtml, /managedWebSocketDisconnected\(ws,event\)/);
    assert.match(wssHtml, /ws\.onerror=.*Connection unavailable/);
    assert.deepEqual(runtime.operatorDiagnosticsSnapshot("browser_handoff").transport, {
      namespace: "managed_handoff",
      currentTransport: "websocket_relay",
      lastTransport: "websocket_relay",
      generation: 2,
      transitionCount: 1,
      lastFallbackReason: "transport_unavailable",
      wss: {
        namespace: "managed_wss",
        surfaceFailure: "none",
        channelFailure: "none",
        framesObserved: 0,
        inputAttempts: 0,
        inputStage: "none",
        inputBoundaryStage: "none"
      }
    });
    const managed = runtime.managedOperatorDiagnosticsSnapshot("browser_handoff");
    assert.equal(managed.health, "available");
    assert.equal(managed.currentTransport, "websocket_relay");
    assert.equal(managed.previousTransport, "webrtc_direct");
    assert.equal(managed.generation, 2);
    assert.equal(managed.transitionCount, 1);
    assert.equal(managed.fallbackReason, "transport_unavailable");
    assert.equal(managed.wss.authorityBoundary, "valid");
    assert.equal(managed.wss.sessionDisposition, "none");
    assert.deepEqual(managed.events, [{ kind: "transport_transition" }]);
    assert.deepEqual(observed, [{ kind: "transport_transition" }]);
    assert.doesNotMatch(JSON.stringify(managed), /managed-int|managed-principal|4242|7331/);
    await runtime.revoke("managed-int");
  } finally {
    restoreRelayEnv(saved);
  }
});

test("managed fallback reaches optional TURN only after WSS has been fenced", async () => {
  const saved = saveRelayEnv();
  try {
    clearRelayEnv();
    process.env.MCP_HANDOFF_COTURN_SHARED_SECRET = "0123456789abcdef0123456789abcdef";
    process.env.MCP_HANDOFF_COTURN_TURN_URLS = "turn:turn.example.test:3478?transport=udp";
    const runtime = fixture();
    const direct = runtime.start(request());
    const directCap = await fallbackCapability(runtime, direct);
    const toWss = await runtime.handle(fallbackRequest(sessionId(direct), directCap), PRINCIPAL);
    assert.equal(toWss.status, 200);
    const wssPath = (await toWss.json() as { path: string }).path;
    const wssLocator = `${ORIGIN}${wssPath}`;
    const wssCap = await fallbackCapability(runtime, wssLocator);

    const toTurn = await runtime.handle(fallbackRequest(sessionId(wssLocator), wssCap), PRINCIPAL);
    assert.equal(toTurn.status, 200);
    const turnPath = (await toTurn.json() as { path: string }).path;
    assert.notEqual(turnPath, wssPath);
    assert.equal((await runtime.handle(new Request(wssLocator), PRINCIPAL)).status, 404);

    const turnPage = await runtime.handle(new Request(`${ORIGIN}${turnPath}`), PRINCIPAL);
    assert.equal(turnPage.status, 200);
    assert.match(await turnPage.text(), /<video id="video"/);
    assert.deepEqual(runtime.operatorDiagnosticsSnapshot("window_handoff").transport, {
      namespace: "managed_handoff",
      currentTransport: "webrtc_relay",
      lastTransport: "webrtc_relay",
      generation: 3,
      transitionCount: 2,
      lastFallbackReason: "transport_unavailable"
    });
    await runtime.revoke("managed-int");
  } finally {
    restoreRelayEnv(saved);
  }
});

test("managed transport fallback exhausts cleanly instead of replaying or cycling", async () => {
  const saved = saveRelayEnv();
  try {
    clearRelayEnv();
    const runtime = fixture();
    const direct = runtime.start(request());
    const directCap = await fallbackCapability(runtime, direct);
    const toWss = await runtime.handle(fallbackRequest(sessionId(direct), directCap), PRINCIPAL);
    const wssPath = (await toWss.json() as { path: string }).path;
    const wssLocator = `${ORIGIN}${wssPath}`;
    const wssCap = await fallbackCapability(runtime, wssLocator);

    const exhausted = await runtime.handle(fallbackRequest(sessionId(wssLocator), wssCap), PRINCIPAL);
    assert.equal(exhausted.status, 503);
    assert.deepEqual(await exhausted.json(), { error: "transport_fallback_exhausted" });
    assert.equal((await runtime.handle(new Request(wssLocator), PRINCIPAL)).status, 404);
    assert.deepEqual(runtime.operatorDiagnosticsSnapshot("browser_handoff").transport, {
      namespace: "managed_handoff",
      currentTransport: "none",
      lastTransport: "websocket_relay",
      generation: 3,
      transitionCount: 2,
      lastFallbackReason: "transport_unavailable"
    });
    await runtime.revoke("managed-int");
  } finally {
    restoreRelayEnv(saved);
  }
});

test("racing fallback requests cannot both claim a later Human transport", async () => {
  const saved = saveRelayEnv();
  try {
    clearRelayEnv();
    const runtime = fixture();
    const direct = runtime.start(request());
    const directId = sessionId(direct);
    const capability = await fallbackCapability(runtime, direct);
    const [first, second] = await Promise.all([
      runtime.handle(fallbackRequest(directId, capability), PRINCIPAL),
      runtime.handle(fallbackRequest(directId, capability), PRINCIPAL)
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409]);
    const snapshot = runtime.operatorDiagnosticsSnapshot("browser_handoff");
    assert.equal(snapshot.transport.namespace, "managed_handoff");
    if (snapshot.transport.namespace === "managed_handoff") {
      assert.equal(snapshot.transport.currentTransport, "websocket_relay");
      assert.equal(snapshot.transport.generation, 2);
      assert.equal(snapshot.transport.transitionCount, 1);
    }
    await runtime.revoke("managed-int");
  } finally {
    restoreRelayEnv(saved);
  }
});

test("managed runtime honors WSS-first -> direct order exactly", async () => {
  const saved = saveRelayEnv();
  try {
    clearRelayEnv();
    const runtime = new ManagedWindowHandoffRuntime({
      takeover: { enabled: true, publicBaseUrl: ORIGIN, ttlMs: 60_000, reconnectIdleMs: 500 },
      runtime: { hostExecutable: process.execPath },
      managedFallback: { platform: "linux", linuxHostScript: process.execPath, displayName: ":99" },
      transportPolicy: { order: ["websocket_relay", "webrtc_direct"] }
    });
    const wss = runtime.start(request());
    assert.equal(runtime.managedOperatorDiagnosticsSnapshot("browser_handoff").currentTransport, "websocket_relay");
    const capability = await fallbackCapability(runtime, wss);

    const moved = await runtime.handle(fallbackRequest(sessionId(wss), capability), PRINCIPAL);
    assert.equal(moved.status, 200);
    const directPath = (await moved.json() as { path: string }).path;
    const directPage = await runtime.handle(new Request(`${ORIGIN}${directPath}`), PRINCIPAL);
    assert.equal(directPage.status, 200);
    assert.match(await directPage.text(), /<video id="video"/);

    const managed = runtime.managedOperatorDiagnosticsSnapshot("browser_handoff");
    assert.equal(managed.currentTransport, "webrtc_direct");
    assert.equal(managed.previousTransport, "websocket_relay");
    assert.equal(managed.generation, 2);
    assert.equal(managed.transitionCount, 1);
    assert.equal((await runtime.handle(new Request(wss), PRINCIPAL)).status, 404);
    await runtime.revoke("managed-int");
  } finally {
    restoreRelayEnv(saved);
  }
});
