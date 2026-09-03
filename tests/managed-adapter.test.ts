import assert from "node:assert/strict";
import test from "node:test";
import { BrowserHandoffAdapter } from "../src/browser-takeover/browser-handoff-adapter.js";
import { WindowHandoffAdapter, WindowHandoffAdapterError } from "../src/window-takeover/window-handoff-adapter.js";

const ORIGIN = "https://managed-adapter.example";
const PRINCIPAL = "managed-adapter-principal";
const ALL_INPUT = { tap: true, scroll: true, text: true, key: true } as const;

function managedConfig() {
  return {
    takeover: { enabled: true, publicBaseUrl: ORIGIN, ttlMs: 60_000, reconnectIdleMs: 500 },
    runtime: { hostExecutable: process.execPath, displayName: ":99" },
    managedFallback: { platform: "linux", linuxHostScript: process.execPath }
  } as const;
}

test("Browser facade keeps synchronous start while managed fallback stays Handoff-owned", async () => {
  const adapter = new BrowserHandoffAdapter(managedConfig());
  const locator = adapter.start({
    intervention: { id: "managed-browser", epoch: 1 },
    principalBinding: PRINCIPAL,
    target: { processId: 4242, windowId: 7331 },
    inputPolicy: ALL_INPUT
  });
  assert.equal(new URL(locator).origin, ORIGIN);
  const page = await adapter.handle(new Request(locator), PRINCIPAL);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /data-fallback=/);
  const diagnostics = adapter.operatorDiagnosticsSnapshot();
  assert.equal(diagnostics.transport.namespace, "managed_handoff");
  const managedDiagnostics = adapter.managedOperatorDiagnosticsSnapshot();
  assert.equal(managedDiagnostics.namespace, "managed_handoff");
  assert.equal(managedDiagnostics.currentTransport, "webrtc_direct");
  await adapter.revoke("managed-browser");
});

test("Window facade rejects managed fallback when exact-window authority would be widened", () => {
  assert.throws(
    () => new WindowHandoffAdapter({
      ...managedConfig(),
      successorWindowPolicy: { mode: "same_process" }
    }),
    (error: unknown) => error instanceof WindowHandoffAdapterError
      && error.code === "WINDOW_HANDOFF_SUCCESSOR_POLICY_INVALID"
  );
  assert.throws(
    () => new WindowHandoffAdapter({
      ...managedConfig(),
      initialSecureWindowPolicy: { mode: "macos_local_authentication" }
    }),
    (error: unknown) => error instanceof WindowHandoffAdapterError
      && error.code === "WINDOW_HANDOFF_INITIAL_SECURE_WINDOW_POLICY_INVALID"
  );
});

test("managed Window facade requires one exact window without changing the default adapter", () => {
  const managed = new WindowHandoffAdapter(managedConfig());
  assert.throws(
    () => managed.start({
      intervention: { id: "managed-window-process-only", epoch: 1 },
      principalBinding: PRINCIPAL,
      target: { processId: 4242 },
      inputPolicy: ALL_INPUT
    }),
    (error: unknown) => error instanceof WindowHandoffAdapterError
      && error.code === "WINDOW_HANDOFF_TARGET_INVALID"
  );

  const direct = new WindowHandoffAdapter({
    takeover: { enabled: true, publicBaseUrl: ORIGIN, ttlMs: 60_000 },
    runtime: { hostExecutable: process.execPath }
  });
  assert.ok(direct.start({
    intervention: { id: "direct-process-only", epoch: 1 },
    principalBinding: PRINCIPAL,
    target: { processId: 4242 },
    inputPolicy: ALL_INPUT
  }));
  assert.deepEqual(direct.managedOperatorDiagnosticsSnapshot().events, []);
  assert.equal(direct.managedOperatorDiagnosticsSnapshot().currentTransport, "none");
});

test("managed transport policy supports explicit WSS-only without constructing WebRTC authority", async () => {
  const adapter = new BrowserHandoffAdapter({
    ...managedConfig(),
    transportPolicy: { order: ["websocket_relay"] }
  });
  const locator = adapter.start({
    intervention: { id: "managed-wss-only", epoch: 1 },
    principalBinding: PRINCIPAL,
    target: { processId: 4242, windowId: 7331 },
    inputPolicy: ALL_INPUT
  });
  const page = await adapter.handle(new Request(locator), PRINCIPAL);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Remote bounded browser surface/);
  assert.match(html, /function onWebSocketDisconnected\(ws,event\)\{if\(stopped\|\|terminalPending\)return;void managedWebSocketDisconnected\(ws,event\)\}/);
  assert.match(html, /function onInitialWebSocketConnectFailure\(\)\{if\(!stopped&&!terminalPending\)void managedTransportFallback\(\)\}/);
  assert.doesNotMatch(html, /function onWebSocketDisconnected\(ws,event\).*browserWssCloseIsReconnectable\(event\.code\)/);
  assert.equal(adapter.managedOperatorDiagnosticsSnapshot().currentTransport, "websocket_relay");
  assert.deepEqual(adapter.diagnosticsSnapshot().events, []);
  await adapter.revoke("managed-wss-only");
});

test("direct-only transport policy needs no WSS backend and retains process-only Window admission", async () => {
  const adapter = new WindowHandoffAdapter({
    takeover: { enabled: true, publicBaseUrl: ORIGIN, ttlMs: 60_000, reconnectIdleMs: 500 },
    runtime: { hostExecutable: process.execPath },
    transportPolicy: { order: ["webrtc_direct"] },
    successorWindowPolicy: { mode: "same_process" }
  });
  const locator = adapter.start({
    intervention: { id: "managed-direct-only", epoch: 1 },
    principalBinding: PRINCIPAL,
    target: { processId: 4242 },
    inputPolicy: ALL_INPUT
  });
  assert.equal(new URL(locator).origin, ORIGIN);
  assert.equal(adapter.managedOperatorDiagnosticsSnapshot().currentTransport, "webrtc_direct");
  await adapter.revoke("managed-direct-only");
});

test("Linux WSS in an explicit plan fails closed before Human authority when its backend is absent", () => {
  const adapter = new BrowserHandoffAdapter({
    takeover: { enabled: true, publicBaseUrl: ORIGIN, ttlMs: 60_000 },
    runtime: { hostExecutable: process.execPath },
    managedFallback: { platform: "linux" },
    transportPolicy: { order: ["websocket_relay"] }
  });
  assert.throws(
    () => adapter.start({
      intervention: { id: "managed-linux-wss-missing", epoch: 1 },
      principalBinding: PRINCIPAL,
      target: { processId: 4242, windowId: 7331 },
      inputPolicy: ALL_INPUT
    }),
    /Managed Linux WSS requires an exact-window host script and local X11 display/
  );
  assert.equal(adapter.managedOperatorDiagnosticsSnapshot().currentTransport, "none");
});

test("managed macOS WSS-only reuses the runtime host without consumer surface-class selection", async () => {
  const adapter = new WindowHandoffAdapter({
    takeover: { enabled: true, publicBaseUrl: ORIGIN, ttlMs: 60_000 },
    runtime: { hostExecutable: process.execPath },
    managedFallback: { platform: "macos" },
    transportPolicy: { order: ["websocket_relay"] }
  });
  const locator = adapter.start({
    intervention: { id: "managed-macos-wss-only", epoch: 1 },
    principalBinding: PRINCIPAL,
    target: { processId: 4242, windowId: 7331 },
    inputPolicy: ALL_INPUT
  });
  assert.equal((await adapter.handle(new Request(locator), PRINCIPAL)).status, 200);
  assert.equal(adapter.managedOperatorDiagnosticsSnapshot().currentTransport, "websocket_relay");
  await adapter.revoke("managed-macos-wss-only");
});

test("managed macOS successor lineage refuses cross-transport reconstruction of the original target", () => {
  assert.throws(
    () => new WindowHandoffAdapter({
      takeover: { enabled: true, publicBaseUrl: ORIGIN, ttlMs: 60_000 },
      runtime: { hostExecutable: process.execPath },
      managedFallback: { platform: "macos" },
      transportPolicy: { order: ["webrtc_direct", "websocket_relay"] },
      successorWindowPolicy: { mode: "same_process" }
    }),
    (error: unknown) => error instanceof WindowHandoffAdapterError
      && error.code === "WINDOW_HANDOFF_SUCCESSOR_POLICY_INVALID"
      && /WSS-only transport plan/.test(error.message)
  );
});

test("managed macOS WSS-only admits the existing same-process successor policy", async () => {
  const adapter = new WindowHandoffAdapter({
    takeover: { enabled: true, publicBaseUrl: ORIGIN, ttlMs: 60_000 },
    runtime: { hostExecutable: process.execPath },
    managedFallback: { platform: "macos" },
    transportPolicy: { order: ["websocket_relay"] },
    successorWindowPolicy: { mode: "same_process", transitionWindowMs: 650 }
  });
  const locator = adapter.start({
    intervention: { id: "managed-macos-wss-lineage", epoch: 1 },
    principalBinding: PRINCIPAL,
    target: { processId: 4242, windowId: 7331 },
    inputPolicy: ALL_INPUT
  });
  assert.equal((await adapter.handle(new Request(locator), PRINCIPAL)).status, 200);
  assert.equal(adapter.managedOperatorDiagnosticsSnapshot().currentTransport, "websocket_relay");
  await adapter.revoke("managed-macos-wss-lineage");
});

test("managed macOS LocalAuthentication WSS stays PID-only and policy-bounded", async () => {
  const adapter = new WindowHandoffAdapter({
    takeover: { enabled: true, publicBaseUrl: ORIGIN, ttlMs: 60_000 },
    runtime: { hostExecutable: process.execPath },
    managedFallback: { platform: "macos" },
    transportPolicy: { order: ["websocket_relay"] },
    initialSecureWindowPolicy: { mode: "macos_local_authentication" }
  });
  const locator = adapter.start({
    intervention: { id: "managed-macos-local-auth", epoch: 1 },
    principalBinding: PRINCIPAL,
    target: { processId: 4242 },
    inputPolicy: { tap: true, scroll: false, text: true, key: true }
  });
  assert.equal((await adapter.handle(new Request(locator), PRINCIPAL)).status, 200);
  assert.equal(adapter.managedOperatorDiagnosticsSnapshot().currentTransport, "websocket_relay");
  await adapter.revoke("managed-macos-local-auth");
});


test("managed WSS rejects unknown host platforms before any Human authority", () => {
  assert.throws(
    () => new WindowHandoffAdapter({
      takeover: { enabled: true, publicBaseUrl: ORIGIN, ttlMs: 60_000 },
      runtime: { hostExecutable: process.execPath },
      managedFallback: { platform: "windows" as never },
      transportPolicy: { order: ["websocket_relay"] }
    }),
    /Managed Window WSS platform is invalid/
  );
});

test("WSS-specific surface limitations do not block WebRTC-only secure policy", () => {
  assert.doesNotThrow(() => new WindowHandoffAdapter({
    takeover: { enabled: true, publicBaseUrl: ORIGIN, ttlMs: 60_000 },
    runtime: { hostExecutable: process.execPath },
    transportPolicy: { order: ["webrtc_direct"] },
    initialSecureWindowPolicy: { mode: "macos_local_authentication" }
  }));
});
