import assert from "node:assert/strict";
import test from "node:test";
import { WindowHandoffAdapter, WindowHandoffAdapterError } from "../src/window-takeover/window-handoff-adapter.js";

const ORIGIN = "https://window-handoff.example";
const PRINCIPAL = "principal-window-handoff";
const POINTER_ONLY = { tap: true, scroll: true, text: false, key: false } as const;

function fixture(onComplete?: (event: { interventionId: string; epoch: number }) => void | Promise<void>) {
  return new WindowHandoffAdapter({
    takeover: { enabled: true, publicBaseUrl: ORIGIN, ttlMs: 60_000, reconnectIdleMs: 5_000 },
    runtime: { hostExecutable: process.execPath, hostArgs: ["-e", "process.exit(0)"] },
    onComplete
  });
}

test("first-class Window Handoff issues only a WebRTC locator for an exact bounded target", async () => {
  const adapter = fixture();
  const locator = adapter.start({
    intervention: { id: "window-int-1", epoch: 4 },
    principalBinding: PRINCIPAL,
    target: { processId: 4242, windowId: 7331 },
    inputPolicy: POINTER_ONLY
  });
  const url = new URL(locator);
  assert.equal(url.origin, ORIGIN);
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  assert.equal(adapter.ownsPath(url.pathname), true);

  const page = await adapter.handle(new Request(`http://localhost${url.pathname}`), PRINCIPAL);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<video id="video"/);
  assert.match(html, /\/takeover\/webrtc-client\.js/);
  assert.doesNotMatch(html, /\/takeover\/client\.js/);
});

test("Window Handoff requires an explicit process boundary and bounded input policy", () => {
  const adapter = fixture();
  assert.throws(
    () => adapter.start({
      intervention: { id: "window-int-invalid", epoch: 1 },
      principalBinding: PRINCIPAL,
      target: { processId: 0 },
      inputPolicy: POINTER_ONLY
    }),
    (error: unknown) => error instanceof WindowHandoffAdapterError && error.code === "WINDOW_HANDOFF_TARGET_INVALID"
  );
  assert.throws(
    () => adapter.start({
      intervention: { id: "window-int-policy", epoch: 1 },
      principalBinding: PRINCIPAL,
      target: { processId: 4242 },
      inputPolicy: { tap: true, scroll: true, text: false } as never
    }),
    (error: unknown) => error instanceof WindowHandoffAdapterError && error.code === "WINDOW_HANDOFF_INPUT_POLICY_INVALID"
  );
});

test("Window Handoff has no display-wide fallback and disabled transport fails closed", () => {
  const disabled = new WindowHandoffAdapter({
    takeover: { enabled: false, publicBaseUrl: ORIGIN, ttlMs: 60_000 },
    runtime: { hostExecutable: process.execPath }
  });
  assert.throws(
    () => disabled.start({
      intervention: { id: "window-int-disabled", epoch: 1 },
      principalBinding: PRINCIPAL,
      target: { processId: 4242 },
      inputPolicy: POINTER_ONLY
    }),
    (error: unknown) => error instanceof WindowHandoffAdapterError && error.code === "WINDOW_HANDOFF_UNAVAILABLE"
  );
});

test("Window Handoff completion remains post-fence and consumer-owned", async () => {
  const events: Array<{ interventionId: string; epoch: number }> = [];
  const adapter = fixture((event) => { events.push(event); });
  const locator = adapter.start({
    intervention: { id: "window-int-complete", epoch: 9 },
    principalBinding: PRINCIPAL,
    target: { processId: 4242, windowId: 7331 },
    inputPolicy: POINTER_ONLY
  });
  const url = new URL(locator);
  const sessionId = url.pathname.split("/").at(-1)!;
  const page = await adapter.handle(new Request(`http://localhost${url.pathname}`), PRINCIPAL);
  const html = await page.text();
  const completion = /data-completion="([A-Za-z0-9_-]{32,128})"/.exec(html)?.[1];
  assert.ok(completion);
  const result = await adapter.handle(new Request(`http://localhost/takeover/api/complete/${sessionId}`, {
    method: "POST",
    headers: { origin: ORIGIN, "x-mcp-takeover-completion": completion }
  }), PRINCIPAL);
  assert.equal(result.status, 200);
  assert.deepEqual(events, [{ interventionId: "window-int-complete", epoch: 9 }]);
});

test("Browser and Window facades share the same bounded route/session core contract", async () => {
  const adapter = fixture();
  assert.equal(adapter.isEnabled(), true);
  assert.equal(adapter.isPath("/takeover/example"), true);
  assert.equal(adapter.isPath("/other"), false);
  assert.deepEqual(adapter.diagnosticsSnapshot(), { events: [] });
  assert.equal(adapter.latencySnapshot().direct.samples, 0);
  const locator = adapter.start({
    intervention: { id: "window-int-owned", epoch: 1 },
    principalBinding: PRINCIPAL,
    target: { processId: 4242 },
    inputPolicy: POINTER_ONLY
  });
  assert.equal(adapter.ownsPath(new URL(locator).pathname), true);
  await adapter.revoke("window-int-owned");
  assert.equal(adapter.ownsPath(new URL(locator).pathname), false);
  await adapter.revokeForIntervention("not-active");

  const unclaimed = adapter.start({
    intervention: { id: "window-int-unclaimed", epoch: 2 },
    principalBinding: PRINCIPAL,
    target: { processId: 4242 },
    inputPolicy: POINTER_ONLY
  });
  assert.equal(adapter.ownsPath(new URL(unclaimed).pathname), true);
  adapter.revokeUnclaimed("window-int-unclaimed");
  assert.equal(adapter.ownsPath(new URL(unclaimed).pathname), false);
});
