import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserHandoffAdapter,
  BrowserHandoffAdapterError
} from "../src/browser-takeover/browser-handoff-adapter.js";

const ORIGIN = "https://takeover.example";
const PRINCIPAL = "principal-browser-handoff";

function fixture() {
  return new BrowserHandoffAdapter({
    takeover: {
      enabled: true,
      publicBaseUrl: ORIGIN,
      ttlMs: 60_000,
      reconnectIdleMs: 5_000
    },
    runtime: {
      hostExecutable: process.execPath,
      hostArgs: ["-e", "process.exit(0)"]
    }
  });
}

test("first-class Browser Handoff issues only a WebRTC locator for an exact target", async () => {
  const adapter = fixture();
  const locator = adapter.start({
    intervention: { id: "browser-int-1", epoch: 3 },
    principalBinding: PRINCIPAL,
    target: { processId: 4242, windowId: 7331 }
  });
  const url = new URL(locator);
  assert.equal(url.origin, ORIGIN);
  assert.equal(url.search, "");
  assert.equal(url.hash, "");

  const page = await adapter.handle(new Request(`http://localhost${url.pathname}`), PRINCIPAL);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<video id="video"/);
  assert.match(html, /\/takeover\/webrtc-client\.js/);
  assert.doesNotMatch(html, /\/takeover\/client\.js/);

  const sessionId = url.pathname.split("/").at(-1);
  assert.ok(sessionId);
  const legacyBootstrap = await adapter.handle(new Request(
    `http://localhost/takeover/api/bootstrap/${sessionId}`,
    { headers: { "sec-fetch-site": "same-origin", "x-takeover-client": "client-binding-browser-1234" } }
  ), PRINCIPAL);
  assert.equal(legacyBootstrap.status, 404);
});

test("Browser Handoff fails closed for invalid or unavailable targets instead of downgrading", () => {
  const adapter = fixture();
  assert.throws(
    () => adapter.start({
      intervention: { id: "browser-int-invalid", epoch: 1 },
      principalBinding: PRINCIPAL,
      target: { processId: 0 }
    }),
    (error: unknown) => error instanceof BrowserHandoffAdapterError && error.code === "BROWSER_HANDOFF_TARGET_INVALID"
  );

  const disabled = new BrowserHandoffAdapter({
    takeover: { enabled: false, publicBaseUrl: ORIGIN, ttlMs: 60_000 },
    runtime: { hostExecutable: process.execPath }
  });
  assert.throws(
    () => disabled.start({
      intervention: { id: "browser-int-disabled", epoch: 1 },
      principalBinding: PRINCIPAL,
      target: { processId: 4242 }
    }),
    (error: unknown) => error instanceof BrowserHandoffAdapterError && error.code === "BROWSER_HANDOFF_UNAVAILABLE"
  );
});

test("Browser Handoff keeps WebRTC lifecycle routing and bounded diagnostics Handoff-owned", async () => {
  const adapter = fixture();
  assert.equal(adapter.isEnabled(), true);
  assert.equal(adapter.isPath("/takeover/example"), true);
  assert.equal(adapter.isPath("/other"), false);

  const diagnostics = adapter.diagnosticsSnapshot();
  assert.deepEqual(diagnostics, { events: [] });
  const latency = adapter.latencySnapshot();
  assert.equal(latency.direct.samples, 0);
  assert.equal(latency.relay.samples, 0);

  await adapter.revoke("not-active");
  await adapter.revokeForIntervention("not-active-either");
});
