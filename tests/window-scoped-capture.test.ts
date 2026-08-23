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
  assert.match(host, /THIN_TAKEOVER_TARGET_WINDOW_ID/);
  assert.match(host, /window\.owningApplication\?\.processID == targetProcessID/);
  assert.match(host, /targetWindowID == nil \|\| window\.windowID == targetWindowID/);
  assert.match(host, /window\.windowLayer == 0/);
  assert.match(host, /targetWindowID == nil \|\| window\.windowID == targetWindowID/);
  assert.match(host, /windows\.count == 1/);
  assert.match(host, /SCContentFilter\(display: display, including: \[window\]\)/);
  assert.match(host, /containingDisplays\.count == 1/);
  assert.match(host, /sourceRect = CGRect\(/);
  assert.match(host, /window\.frame\.minX - display\.frame\.minX/);
  assert.match(host, /config\.sourceRect = sourceRect/);
  assert.match(host, /inputBounds: window\.frame/);
  assert.match(input, /private let inputBounds: CGRect/);
  assert.match(input, /private let targetProcessID: pid_t\?/);
  assert.match(input, /event\.postToPid\(targetProcessID\)/);
  assert.match(input, /guard activateTargetWindowForInput\(\) else/);
  assert.match(input, /matches\.count == 1/);
  assert.match(input, /AXUIElementPerformAction\(window, kAXRaiseAction as CFString\)/);
  assert.doesNotMatch(input, /CGDisplayBounds\(displayID\)/);
});

test("browser WebRTC host uses the same target-PID window-only capture and input boundary", () => {
  const host = source("experiments/thin-takeover-runtime/Sources/takeover-webrtc-host/main.swift");
  assert.match(host, /TAKEOVER_WEBRTC_TARGET_PID/);
  assert.match(host, /TAKEOVER_WEBRTC_TARGET_WINDOW_ID/);
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
  assert.match(host, /CGEventSource\(stateID: \.combinedSessionState\)/);
  assert.doesNotMatch(host, /CGEventSource\(stateID: \.hidSystemState\)/);
  assert.match(host, /private let targetProcessID: pid_t\?/);
  assert.match(host, /event\.postToPid\(targetProcessID\)/);
  assert.match(host, /guard activateTargetWindowForInput\(\) else \{ return \}/);
  assert.match(host, /NSRunningApplication\(processIdentifier: targetProcessID\)/);
  assert.match(host, /kAXWindowsAttribute/);
  assert.match(host, /abs\(frame\.minX - inputBounds\.minX\) <= 2/);
  assert.match(host, /AXUIElementPerformAction\(window, kAXRaiseAction as CFString\)/);
  assert.match(host, /application\.activate\(options: \[\]\)/);
  assert.match(host, /HumanInputInjector\(inputBounds: surface\.inputBounds, targetProcessID: targetProcessID, writer: writer\)/);
});

test("Node runtime passes target PID and optional display only through the private helper environment", () => {
  const native = source("src/browser-takeover/native-runtime.ts");
  const webrtc = source("src/browser-takeover/webrtc-runtime.ts");
  assert.match(native, /env\.THIN_TAKEOVER_TARGET_PID = String\(binding\.targetProcessId\)/);
  assert.match(native, /env\.THIN_TAKEOVER_TARGET_WINDOW_ID = String\(binding\.targetWindowId\)/);
  assert.match(webrtc, /env\.TAKEOVER_WEBRTC_TARGET_PID = String\(binding\.targetProcessId\)/);
  assert.match(webrtc, /env\.TAKEOVER_WEBRTC_TARGET_WINDOW_ID = String\(binding\.targetWindowId\)/);
  assert.match(webrtc, /env\.TAKEOVER_WEBRTC_DISPLAY_NAME = this\.config\.displayName/);
});


test("macOS dogfood target exposes verification through the exact window title", () => {
  const target = source("experiments/thin-takeover-runtime/Sources/takeover-macos-dogfood-target/main.swift");
  assert.match(target, /CUMG Handoff Dogfood Target — agent_ready/);
  assert.match(target, /CUMG Handoff Dogfood Target — human_clicked/);
  assert.match(target, /window\?\.title = "CUMG Handoff Dogfood Target — human_clicked"/);
});
