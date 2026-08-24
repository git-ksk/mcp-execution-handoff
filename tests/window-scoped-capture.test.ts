import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

test("macOS Native host delegates exact-window capture and input to the shared bounded primitive", () => {
  const host = source("experiments/thin-takeover-runtime/Sources/takeover-macos-host/MacHost.swift");
  const input = source("experiments/thin-takeover-runtime/Sources/takeover-macos-host/InputInjector.swift");
  const exact = source("experiments/thin-takeover-runtime/Sources/TakeoverMacOSWindow/ExactWindowSurface.swift");
  assert.match(host, /THIN_TAKEOVER_TARGET_PID/);
  assert.match(host, /THIN_TAKEOVER_TARGET_WINDOW_ID/);
  assert.match(host, /import TakeoverMacOSWindow/);
  assert.match(host, /MacOSExactWindowCapture\.resolve\(/);
  assert.match(host, /config\.sourceRect = sourceRect/);
  assert.match(input, /import TakeoverMacOSWindow/);
  assert.match(input, /private let inputBounds: CGRect/);
  assert.match(input, /private let targetProcessID: pid_t\?/);
  assert.match(input, /event\.postToPid\(targetProcessID\)/);
  assert.match(input, /guard activateTargetWindowForInput\(\) else/);
  assert.match(input, /MacOSExactWindowInput\.activate\(processID: targetProcessID, inputBounds: inputBounds\)/);

  assert.match(exact, /window\.processID == targetProcessID/);
  assert.match(exact, /targetWindowID == nil \|\| window\.windowID == targetWindowID/);
  assert.match(exact, /window\.layer == 0/);
  assert.match(exact, /matchingWindowIndices\.count == 1/);
  assert.match(exact, /containingDisplayIndices\.count == 1/);
  assert.match(exact, /SCContentFilter\(display: display, including: \[window\]\)/);
  assert.match(exact, /window\.frame\.minX - display\.frame\.minX/);
  assert.match(exact, /matches\.count == 1/);
  assert.match(exact, /AXUIElementPerformAction\(window, kAXRaiseAction as CFString\)/);
  assert.match(exact, /application\.activate\(options: \[\]\)/);
  assert.doesNotMatch(exact, /excludingWindows:/);
  assert.doesNotMatch(exact, /CGDisplayBounds\(/);
});

test("browser WebRTC host reuses the same shared exact-window primitive without widening its browser policy", () => {
  const host = source("experiments/thin-takeover-runtime/Sources/takeover-webrtc-host/main.swift");
  assert.match(host, /TAKEOVER_WEBRTC_TARGET_PID/);
  assert.match(host, /TAKEOVER_WEBRTC_TARGET_WINDOW_ID/);
  assert.match(host, /import TakeoverMacOSWindow/);
  assert.match(host, /MacOSExactWindowCapture\.resolve\(/);
  assert.match(host, /configuration\.sourceRect = sourceRect/);
  assert.match(host, /private let inputBounds: CGRect/);
  assert.match(host, /CGEventSource\(stateID: \.combinedSessionState\)/);
  assert.doesNotMatch(host, /CGEventSource\(stateID: \.hidSystemState\)/);
  assert.match(host, /private let targetProcessID: pid_t\?/);
  assert.match(host, /event\.postToPid\(targetProcessID\)/);
  assert.match(host, /guard activateTargetWindowForInput\(\) else \{ return \}/);
  assert.match(host, /MacOSExactWindowInput\.activate\(processID: targetProcessID, inputBounds: inputBounds\)/);
  assert.match(host, /HumanInputInjector\(inputBounds: surface\.inputBounds, targetProcessID: targetProcessID, writer: writer\)/);
  // Browser-only editable-region semantics stay in the WebRTC host rather than leaking into the
  // shared target-surface primitive.
  assert.match(host, /firstWebArea/);
  assert.match(host, /elementIsEditable/);
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
