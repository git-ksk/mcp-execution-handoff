import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

test("macOS Native host scopes target-PID capture and input to the same exact window", () => {
  const host = source("experiments/thin-takeover-runtime/Sources/takeover-macos-host/MacHost.swift");
  const input = source("experiments/thin-takeover-runtime/Sources/takeover-macos-host/InputInjector.swift");
  assert.match(host, /THIN_TAKEOVER_TARGET_PID/);
  assert.match(host, /window\.owningApplication\?\.processID == targetProcessID/);
  assert.match(host, /window\.windowLayer == 0/);
  assert.match(host, /windows\.count == 1/);
  assert.match(host, /SCContentFilter\(display: display, including: \[window\]\)/);
  assert.match(host, /containingDisplays\.count == 1/);
  assert.match(host, /sourceRect = CGRect\(/);
  assert.match(host, /window\.frame\.minX - display\.frame\.minX/);
  assert.match(host, /config\.sourceRect = sourceRect/);
  assert.match(host, /inputBounds: window\.frame/);
  assert.match(input, /private let inputBounds: CGRect/);
  assert.doesNotMatch(input, /CGDisplayBounds\(displayID\)/);
});

test("browser WebRTC host uses the same target-PID window-only capture and input boundary", () => {
  const host = source("experiments/thin-takeover-runtime/Sources/takeover-webrtc-host/main.swift");
  assert.match(host, /TAKEOVER_WEBRTC_TARGET_PID/);
  assert.match(host, /window\.owningApplication\?\.processID == targetProcessID/);
  assert.match(host, /window\.windowLayer == 0/);
  assert.match(host, /windows\.count == 1/);
  assert.match(host, /SCContentFilter\(display: display, including: \[window\]\)/);
  assert.match(host, /containingDisplays\.count == 1/);
  assert.match(host, /sourceRect = CGRect\(/);
  assert.match(host, /window\.frame\.minX - display\.frame\.minX/);
  assert.match(host, /configuration\.sourceRect = sourceRect/);
  assert.match(host, /inputBounds: window\.frame/);
  assert.match(host, /private let inputBounds: CGRect/);
});

test("Node runtime passes target PID only through the private macOS helper environment", () => {
  const native = source("src/browser-takeover/native-runtime.ts");
  const webrtc = source("src/browser-takeover/webrtc-runtime.ts");
  assert.match(native, /env\.THIN_TAKEOVER_TARGET_PID = String\(binding\.targetProcessId\)/);
  assert.match(webrtc, /env\.TAKEOVER_WEBRTC_TARGET_PID = String\(binding\.targetProcessId\)/);
});
