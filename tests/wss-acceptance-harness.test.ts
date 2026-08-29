import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

test("macOS ordinary WSS physical harness is self-contained and HTTPS/WSS-only", () => {
  const script = source("experiments/thin-takeover-runtime/scripts/macos-wss-window-acceptance.mts");
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  const command = pkg.scripts["accept:window:macos-wss"] ?? "";

  assert.match(command, /takeover-webrtc-host/);
  assert.match(command, /takeover-macos-text-input-fixture/);
  assert.match(script, /takeover-macos-text-input-fixture/);
  assert.match(script, /WSS_ACCEPT_OK/);
  assert.match(script, /HANDOFF_WSS_PORT/);
  assert.match(script, /resolveWssAcceptanceIngress\(PORT\)/);
  assert.match(script, /server\.listen\(PORT, "127\.0\.0\.1"/);
  assert.match(script, /stopWssAcceptanceTunnel/);
  assert.match(script, /stopChild\(fixtureProcess\)/);
  assert.doesNotMatch(script, /latencySnapshot/);
  assert.doesNotMatch(script, /server\.listen\(PORT, "0\.0\.0\.0"/);
  assert.doesNotMatch(script, /HANDOFF_LAN_HOST/);
});

test("WSS physical ingress keeps exact HTTPS Origin while tunneling only a loopback origin", () => {
  const script = source("experiments/thin-takeover-runtime/scripts/wss-public-ingress.mts");
  assert.match(script, /url\.protocol !== "https:"/);
  assert.match(script, /http:\/\/127\.0\.0\.1:\$\{port\}/);
  assert.match(script, /trycloudflare\\\.com/);
  assert.match(script, /HANDOFF_WSS_PUBLIC_BASE_URL must be one exact HTTPS origin/);
  assert.match(script, /slice\(-16 \* 1024\)/);
  assert.doesNotMatch(script, /console\.log/);
});

test("LocalAuthentication WSS harness shares public HTTPS ingress without inventing WebRTC metrics", () => {
  const script = source("experiments/thin-takeover-runtime/scripts/macos-local-auth-wss-acceptance.mts");
  assert.match(script, /resolveWssAcceptanceIngress\(PORT\)/);
  assert.match(script, /server\.listen\(PORT, "127\.0\.0\.1"/);
  assert.match(script, /macos_local_authentication/);
  assert.match(script, /MCP_HANDOFF_COTURN_SHARED_SECRET/);
  assert.match(script, /stopWssAcceptanceTunnel/);
  assert.doesNotMatch(script, /latencySnapshot/);
  assert.doesNotMatch(script, /HANDOFF_LAN_HOST/);
});
