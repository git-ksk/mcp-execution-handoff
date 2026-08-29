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
    managedFallback: { linuxHostScript: process.execPath }
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
