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

test("Window Handoff keeps completion route ownership after media ttl without extending input", async () => {
  const adapter = new WindowHandoffAdapter({
    takeover: {
      enabled: true,
      publicBaseUrl: ORIGIN,
      ttlMs: 1_000,
      reconnectIdleMs: 250,
      completionGraceMs: 1_500
    },
    runtime: { hostExecutable: process.execPath, hostArgs: ["-e", "process.exit(0)"] }
  });
  const locator = adapter.start({
    intervention: { id: "window-int-completion-route", epoch: 1 },
    principalBinding: PRINCIPAL,
    target: { processId: 4242, windowId: 7331 },
    inputPolicy: POINTER_ONLY
  });
  const sessionId = new URL(locator).pathname.split("/").at(-1)!;
  const claimed = await adapter.handle(new Request(
    `http://localhost/takeover/api/webrtc-prepare-claim/${sessionId}`,
    {
      method: "POST",
      headers: { origin: ORIGIN, "x-takeover-client": "window-client-1234567890abcd" }
    }
  ), PRINCIPAL);
  assert.equal(claimed.status, 200);

  await new Promise((resolve) => setTimeout(resolve, 1_100));

  assert.equal(adapter.ownsPath(new URL(locator).pathname), true);
  const completionPage = await adapter.handle(
    new Request(`http://localhost${new URL(locator).pathname}`),
    PRINCIPAL
  );
  assert.equal(completionPage.status, 200);
  assert.match(await completionPage.text(), /data-completion=/);
  await adapter.revoke("window-int-completion-route");
  assert.equal(adapter.ownsPath(new URL(locator).pathname), false);
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
  assert.deepEqual(adapter.operatorDiagnosticsSnapshot(), {
    version: 1, source: "window_handoff", health: "idle",
    transport: { namespace: "webrtc", eventCount: 0 }
  });
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

test("Window Handoff successor lineage is explicit and bounded while exact-one remains the default", () => {
  const exactOnly = fixture();
  assert.ok(exactOnly.start({
    intervention: { id: "window-int-exact-default", epoch: 1 },
    principalBinding: PRINCIPAL,
    target: { processId: 4242 },
    inputPolicy: POINTER_ONLY
  }));

  const lineage = new WindowHandoffAdapter({
    takeover: { enabled: true, publicBaseUrl: ORIGIN, ttlMs: 60_000 },
    runtime: { hostExecutable: process.execPath, hostArgs: ["-e", "process.exit(0)"] },
    successorWindowPolicy: { mode: "same_process", transitionWindowMs: 650 }
  });
  assert.ok(lineage.start({
    intervention: { id: "window-int-lineage", epoch: 1 },
    principalBinding: PRINCIPAL,
    target: { processId: 4242, windowId: 7331 },
    inputPolicy: POINTER_ONLY
  }));

  assert.throws(
    () => new WindowHandoffAdapter({
      takeover: { enabled: true, publicBaseUrl: ORIGIN, ttlMs: 60_000 },
      runtime: { hostExecutable: process.execPath },
      successorWindowPolicy: { mode: "same_process", transitionWindowMs: 5 }
    }),
    (error: unknown) => error instanceof WindowHandoffAdapterError
      && error.code === "WINDOW_HANDOFF_SUCCESSOR_POLICY_INVALID"
  );
});

test("LocalAuthentication initial secure Window policy is explicit PID-only tap-only authority", () => {
  const secure = new WindowHandoffAdapter({
    takeover: { enabled: true, publicBaseUrl: ORIGIN, ttlMs: 60_000 },
    runtime: { hostExecutable: process.execPath, hostArgs: ["-e", "process.exit(0)"] },
    initialSecureWindowPolicy: { mode: "macos_local_authentication" }
  });
  assert.ok(secure.start({
    intervention: { id: "window-int-local-auth", epoch: 1 },
    principalBinding: PRINCIPAL,
    target: { processId: 6050 },
    inputPolicy: { tap: true, scroll: false, text: false, key: false }
  }));
  assert.throws(
    () => secure.start({
      intervention: { id: "window-int-local-auth-stale-window", epoch: 1 },
      principalBinding: PRINCIPAL,
      target: { processId: 6050, windowId: 28942 },
      inputPolicy: { tap: true, scroll: false, text: false, key: false }
    }),
    (error: unknown) => error instanceof WindowHandoffAdapterError
      && error.code === "WINDOW_HANDOFF_TARGET_INVALID"
  );
  assert.throws(
    () => secure.start({
      intervention: { id: "window-int-local-auth-text", epoch: 1 },
      principalBinding: PRINCIPAL,
      target: { processId: 6050 },
      inputPolicy: { tap: true, scroll: false, text: true, key: false }
    }),
    (error: unknown) => error instanceof WindowHandoffAdapterError
      && error.code === "WINDOW_HANDOFF_INPUT_POLICY_INVALID"
  );
});

test("LocalAuthentication policy is closed-world and cannot combine with successor lineage", () => {
  assert.throws(
    () => new WindowHandoffAdapter({
      takeover: { enabled: true, publicBaseUrl: ORIGIN, ttlMs: 60_000 },
      runtime: { hostExecutable: process.execPath },
      initialSecureWindowPolicy: { mode: "other" } as never
    }),
    (error: unknown) => error instanceof WindowHandoffAdapterError
      && error.code === "WINDOW_HANDOFF_INITIAL_SECURE_WINDOW_POLICY_INVALID"
  );
  assert.throws(
    () => new WindowHandoffAdapter({
      takeover: { enabled: true, publicBaseUrl: ORIGIN, ttlMs: 60_000 },
      runtime: { hostExecutable: process.execPath },
      successorWindowPolicy: { mode: "same_process" },
      initialSecureWindowPolicy: { mode: "macos_local_authentication" }
    }),
    (error: unknown) => error instanceof WindowHandoffAdapterError
      && error.code === "WINDOW_HANDOFF_INITIAL_SECURE_WINDOW_POLICY_INVALID"
  );
});
