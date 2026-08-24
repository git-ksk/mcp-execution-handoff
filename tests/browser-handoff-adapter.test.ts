import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserHandoffAdapter,
  BrowserHandoffAdapterError
} from "../src/browser-takeover/browser-handoff-adapter.js";

const ORIGIN = "https://takeover.example";
const PRINCIPAL = "principal-browser-handoff";
const ALL_INPUT = { tap: true, scroll: true, text: true, key: true } as const;

function fixture(onComplete?: (event: { interventionId: string; epoch: number }) => void | Promise<void>) {
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
    },
    onComplete
  });
}

test("first-class Browser Handoff issues only a WebRTC locator for an exact target", async () => {
  const adapter = fixture();
  const locator = adapter.start({
    intervention: { id: "browser-int-1", epoch: 3 },
    principalBinding: PRINCIPAL,
    target: { processId: 4242, windowId: 7331 },
    inputPolicy: ALL_INPUT
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
  assert.equal(adapter.ownsPath(url.pathname), true);
  assert.equal(adapter.ownsPath(`/takeover/api/webrtc-connect/${sessionId}`), true);
  assert.equal(adapter.ownsPath("/takeover/webrtc-client.js"), true);
  assert.equal(adapter.ownsPath("/takeover/client.js"), false);
  assert.equal(adapter.ownsPath("/takeover/not-owned-session"), false);
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
      target: { processId: 0 },
      inputPolicy: ALL_INPUT
    }),
    (error: unknown) => error instanceof BrowserHandoffAdapterError && error.code === "BROWSER_HANDOFF_TARGET_INVALID"
  );

  assert.throws(
    () => adapter.start({
      intervention: { id: "browser-int-invalid-policy", epoch: 1 },
      principalBinding: PRINCIPAL,
      target: { processId: 4242 },
      inputPolicy: { tap: true, scroll: true, text: true } as never
    }),
    (error: unknown) => error instanceof BrowserHandoffAdapterError && error.code === "BROWSER_HANDOFF_INPUT_POLICY_INVALID"
  );

  const disabled = new BrowserHandoffAdapter({
    takeover: { enabled: false, publicBaseUrl: ORIGIN, ttlMs: 60_000 },
    runtime: { hostExecutable: process.execPath }
  });
  assert.throws(
    () => disabled.start({
      intervention: { id: "browser-int-disabled", epoch: 1 },
      principalBinding: PRINCIPAL,
      target: { processId: 4242 },
      inputPolicy: ALL_INPUT
    }),
    (error: unknown) => error instanceof BrowserHandoffAdapterError && error.code === "BROWSER_HANDOFF_UNAVAILABLE"
  );
});

test("Browser Handoff completion callback runs after fencing and retries only after handler failure", async () => {
  const events: Array<{ interventionId: string; epoch: number }> = [];
  let attempts = 0;
  const adapter = fixture(async (event) => {
    attempts += 1;
    if (attempts === 1) throw new Error("verification coordinator unavailable");
    events.push(event);
  });
  const locator = adapter.start({
    intervention: { id: "browser-int-complete", epoch: 7 },
    principalBinding: PRINCIPAL,
    target: { processId: 4242 },
    inputPolicy: ALL_INPUT
  });
  const path = new URL(locator).pathname;
  const sessionId = path.split("/").at(-1)!;
  const page = await adapter.handle(new Request(`http://localhost${path}`), PRINCIPAL);
  const html = await page.text();
  const completion = /data-completion="([A-Za-z0-9_-]{32,128})"/.exec(html)?.[1];
  assert.ok(completion);

  const first = await adapter.handle(new Request(`http://localhost/takeover/api/complete/${sessionId}`, {
    method: "POST",
    headers: { origin: ORIGIN, "x-mcp-takeover-completion": completion }
  }), PRINCIPAL);
  assert.equal(first.status, 503);
  assert.equal(attempts, 1);
  assert.deepEqual(events, []);

  const retry = await adapter.handle(new Request(`http://localhost/takeover/api/complete/${sessionId}`, {
    method: "POST",
    headers: { origin: ORIGIN, "x-mcp-takeover-completion": completion }
  }), PRINCIPAL);
  assert.equal(retry.status, 200);
  assert.equal(attempts, 2);
  assert.deepEqual(events, [{ interventionId: "browser-int-complete", epoch: 7 }]);

  const duplicate = await adapter.handle(new Request(`http://localhost/takeover/api/complete/${sessionId}`, {
    method: "POST",
    headers: { origin: ORIGIN, "x-mcp-takeover-completion": completion }
  }), PRINCIPAL);
  assert.equal(duplicate.status, 200);
  assert.equal(attempts, 2, "successful completion delivery must be idempotent");
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

  const locator = adapter.start({
    intervention: { id: "browser-int-owned", epoch: 1 },
    principalBinding: PRINCIPAL,
    target: { processId: 4242 },
    inputPolicy: ALL_INPUT
  });
  assert.equal(adapter.ownsPath(new URL(locator).pathname), true);
  await adapter.revoke("browser-int-owned");
  assert.equal(adapter.ownsPath(new URL(locator).pathname), false);
  await adapter.revokeForIntervention("not-active-either");
});
