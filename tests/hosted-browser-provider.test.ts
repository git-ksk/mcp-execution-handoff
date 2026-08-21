import assert from "node:assert/strict";
import test from "node:test";
import {
  HostedBrowserTakeoverProvider,
  TakeoverBroker,
  type TakeoverBrowserAdapter
} from "../src/browser-takeover/index.js";

const PRINCIPAL = "principal:single-user";
const CLIENT = "client-binding-1234567890";

function browser(): TakeoverBrowserAdapter {
  return {
    async captureHumanTakeoverFrame() {
      return {
        data: Buffer.from("frame").toString("base64"),
        width: 640,
        height: 480,
        hostname: "accounts.google.com"
      };
    },
    async tapHumanTakeover() {},
    async scrollHumanTakeover() {},
    async insertHumanTakeoverText() {},
    async pressHumanTakeoverKey() {}
  };
}

function broker() {
  return new TakeoverBroker(browser(), {
    enabled: true,
    publicBaseUrl: "https://takeover.example",
    ttlMs: 60_000
  });
}

function sessionId(locator: string): string {
  return new URL(locator).pathname.split("/").filter(Boolean).at(-1)!;
}

test("hosted browser provider wraps the generic broker as an external Human surface", async () => {
  const takeover = broker();
  const provider = new HostedBrowserTakeoverProvider(takeover);
  const grant = await provider.begin({
    interventionId: "intervention-1",
    epoch: 3,
    principalBinding: PRINCIPAL
  });

  assert.equal(provider.kind, "hosted-browser-takeover");
  assert.equal(grant.sessionId, sessionId(grant.locator));
  assert.equal(new URL(grant.locator).origin, "https://takeover.example");

  const page = await takeover.handle(new Request(grant.locator), PRINCIPAL);
  assert.equal(page.status, 200);
});

test("hosted browser provider is idempotent for the same intervention/epoch/principal", async () => {
  const provider = new HostedBrowserTakeoverProvider(broker());
  const request = { interventionId: "intervention-1", epoch: 3, principalBinding: PRINCIPAL };
  const first = await provider.begin(request);
  const second = await provider.begin(request);
  assert.deepEqual(second, first);
});

test("provider revoke invalidates the underlying browser takeover capability", async () => {
  const takeover = broker();
  const provider = new HostedBrowserTakeoverProvider(takeover);
  const grant = await provider.begin({
    interventionId: "intervention-1",
    epoch: 3,
    principalBinding: PRINCIPAL
  });
  const id = sessionId(grant.locator);

  const bootstrap = await takeover.handle(new Request(
    `https://takeover.example/takeover/api/bootstrap/${id}`,
    { headers: { "sec-fetch-site": "same-origin", "x-takeover-client": CLIENT } }
  ), PRINCIPAL);
  assert.equal(bootstrap.status, 200);

  await provider.revoke(grant.sessionId);

  const stale = await takeover.handle(new Request(
    `https://takeover.example/takeover/api/bootstrap/${id}`,
    { headers: { "sec-fetch-site": "same-origin", "x-takeover-client": CLIENT } }
  ), PRINCIPAL);
  assert.equal(stale.status, 404);
});

test("provider rejects malformed external-surface bindings before issuing a broker link", async () => {
  const provider = new HostedBrowserTakeoverProvider(broker());
  await assert.rejects(
    provider.begin({ interventionId: "", epoch: 0, principalBinding: PRINCIPAL }),
    /intervention id/
  );
  await assert.rejects(
    provider.begin({ interventionId: "intervention-1", epoch: -1, principalBinding: PRINCIPAL }),
    /resource epoch/
  );
  await assert.rejects(
    provider.begin({ interventionId: "intervention-1", epoch: 0, principalBinding: "" }),
    /principal binding/
  );
});
