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
  assert.match(input, /MacOSExactWindowTextInput\.commitFocusedText\(/);
  assert.match(input, /case \.rejected:\s*throw InjectionError\.targetUnavailable/);

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
  assert.match(host, /guard activateTargetWindowForInput\(\) else \{[\s\S]*submitInputTextRoute\(\.activationRejected\)[\s\S]*return[\s\S]*\}/);
  assert.match(host, /MacOSExactWindowInput\.activate\(processID: targetProcessID, inputBounds: inputBounds\)/);
  assert.match(host, /MacOSExactWindowTextInput\.commitFocusedText\(/);
  assert.match(host, /MCP_HANDOFF_DIAGNOSTIC input_text_route=/);
  assert.doesNotMatch(host, /MCP_HANDOFF_DIAGNOSTIC input_text_route=.*\\\(text\\\)/);
  assert.match(host, /controlWriter\.submitInputTextRoute\(\.activationRejected\)/);
  assert.match(host, /case \.rejected:\s*controlWriter\.submitInputTextRoute\(\.nativeBoundaryRejected\)\s*return/);
  assert.match(
    host,
    /HumanInputInjector\(\s*inputBounds: surface\.inputBounds,\s*targetProcessID: targetProcessID,\s*writer: writer,\s*controlWriter: controlWriter\s*\)/
  );
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


test("ordinary macOS native text commit remains exact-window bounded and excludes web content", () => {
  const textInput = source(
    "experiments/thin-takeover-runtime/Sources/TakeoverMacOSWindow/ExactWindowTextInput.swift"
  );
  assert.match(textInput, /kAXFocusedWindowAttribute/);
  assert.match(textInput, /MacOSExactWindowGeometry\.framesMatch\(frame, inputBounds\)/);
  assert.match(textInput, /MacOSExactWindowTextInputPolicy\.decision\(/);
  assert.match(textInput, /AXUIElementGetPid\(focusedElement, &focusedPID\)/);
  assert.match(textInput, /focusedPID == processID/);
  assert.match(textInput, /kAXSelectedTextAttribute/);
  assert.match(textInput, /kAXSecureTextFieldSubrole/);
  assert.match(textInput, /AXUIElementIsAttributeSettable/);
  assert.match(textInput, /AXUIElementSetAttributeValue/);
  assert.match(textInput, /currentRole == "AXWebArea"/);
  assert.match(textInput, /return \.web/);
  assert.match(textInput, /return \.unknown/);
  assert.match(textInput, /currentRole == \(kAXApplicationRole as String\)/);
  assert.doesNotMatch(textInput, /kAXValueAttribute/);
});

test("native macOS text acceptance verifies focus and resulting AppKit content", () => {
  const acceptance = source(
    "experiments/thin-takeover-runtime/scripts/macos-native-window-text-acceptance.mts"
  );
  const fixture = source(
    "experiments/thin-takeover-runtime/Sources/takeover-macos-text-input-fixture/main.swift"
  );
  assert.match(fixture, /NSTextView/);
  assert.match(fixture, /window\.firstResponder === textView/);
  assert.match(fixture, /textView\.accessibilityFrame\(\)/);
  assert.match(acceptance, /initial\.tapX/);
  assert.match(acceptance, /initial\.tapY/);
  assert.match(acceptance, /kind: "tap"/);
  assert.match(acceptance, /focused\?\.focused, true/);
  assert.match(acceptance, /kind: "text", text: testText/);
  assert.match(acceptance, /state\?\.text\.includes\(testText\) === true/);
  assert.match(acceptance, /assert\.notEqual\(current\.text, beforeText\)/);
  assert.match(acceptance, /host\.input\.text\.native_ax/);
  assert.match(acceptance, /textRouteStages\.length, TEST_TEXTS\.length/);
  assert.match(acceptance, /process\.exit\(0\)/);
});


test("macOS dogfood target exposes verification through the exact window title", () => {
  const target = source("experiments/thin-takeover-runtime/Sources/takeover-macos-dogfood-target/main.swift");
  assert.match(target, /CUMG Handoff Dogfood Target — agent_ready/);
  assert.match(target, /CUMG Handoff Dogfood Target — human_clicked/);
  assert.match(target, /window\?\.title = "CUMG Handoff Dogfood Target — human_clicked"/);
});
