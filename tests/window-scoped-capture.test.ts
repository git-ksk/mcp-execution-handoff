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
  assert.match(exact, /_ = AXUIElementPerformAction\(window, kAXRaiseAction as CFString\)/);
  assert.doesNotMatch(exact, /guard AXUIElementPerformAction\(window, kAXRaiseAction as CFString\) == \.success/);
  assert.match(exact, /application\.activate\(options: \[\]\)/);
  assert.match(exact, /exactRunningApplication\(processID: processID\)/);
  assert.match(exact, /for attempt in 0\.\.<6/);
  assert.match(exact, /NSRunningApplication\(processIdentifier: processID\)/);
  assert.match(exact, /attempt < 5 \{ usleep\(20_000\) \}/);
  assert.doesNotMatch(exact, /runningApplications\(withBundleIdentifier:/);
  assert.match(exact, /kAXFocusedWindowAttribute/);
  assert.match(exact, /focusedWindowMatches\(appElement: appElement, inputBounds: inputBounds\)/);
  assert.match(exact, /AXUIElementSetAttributeValue\(window, kAXMainAttribute as CFString, kCFBooleanTrue\)/);
  assert.match(exact, /AXUIElementSetAttributeValue\(window, kAXFocusedAttribute as CFString, kCFBooleanTrue\)/);
  assert.match(exact, /private static func requestExactFrontmost\(processID: pid_t\) -> Bool/);
  assert.match(exact, /tell application \\"System Events\\" to set frontmost of first application process whose unix id is/);
  assert.match(exact, /script\.executeAndReturnError\(&error\)/);
  assert.match(exact, /DispatchQueue\.main\.sync\(execute: execute\)/);
  assert.match(exact, /guard requestExactFrontmost\(processID: processID\) else \{ return false \}/);
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
  assert.match(host, /private let targetWindowID: CGWindowID\?/);
  assert.match(host, /MacOSExactWindowAuthority\.revalidate\(/);
  assert.match(host, /guard exactWindowValid else \{[\s\S]*input_stage=authority_lost[\s\S]*return false[\s\S]*\}/);
  assert.match(host, /event\.postToPid\(targetProcessID\)/);
  assert.match(host, /guard activateTargetWindowForInput\(processID: activeProcessID, inputBounds: activeInputBounds\) else \{[\s\S]*submitInputTextRoute\(\.activationRejected\)[\s\S]*input_stage=activation_failed[\s\S]*return[\s\S]*\}/);
  assert.match(host, /MacOSExactWindowInput\.activate\(processID: processID, inputBounds: inputBounds\)/);
  assert.match(host, /MacOSExactWindowTextInput\.commitFocusedText\(/);
  assert.match(host, /MCP_HANDOFF_DIAGNOSTIC input_text_route=/);
  assert.doesNotMatch(host, /MCP_HANDOFF_DIAGNOSTIC input_text_route=.*\\\(text\\\)/);
  assert.match(host, /controlWriter\.submitInputTextRoute\(\.activationRejected\)/);
  assert.match(host, /case \.rejected:\s*controlWriter\.submitInputTextRoute\(\.nativeBoundaryRejected\)\s*return/);
  assert.match(
    host,
    /HumanInputInjector\(\s*inputBounds: surface\.inputBounds,\s*targetProcessID: targetProcessID,\s*targetWindowID: surface\.targetWindowID,\s*targetAuthority: targetAuthority,\s*initialSecureWindowPolicy: initialSecureWindowPolicy,\s*afterPrimaryRelease: \{ lineageController\?\.afterPrimaryRelease\(\) \},\s*writer: writer,\s*controlWriter: controlWriter\s*\)/
  );
  assert.match(host, /private var primaryPressed = false/);
  assert.match(host, /case \"pointer_button\"/);
  assert.match(host, /private func postPrimaryButton\(state: String, at point: CGPoint\) -> Bool/);
  assert.match(host, /func releaseAll\(\)/);
  assert.match(host, /private func cancellationPoint\(\) -> CGPoint/);
  assert.match(host, /CGGetDisplaysWithRect\(activeBounds, 1/);
  assert.match(host, /movePointerForCancellation\(to: cancelAt\)/);
  assert.match(host, /event\.setIntegerValueField\(\.mouseEventClickState, value: 0\)/);
  assert.match(host, /event\.post\(tap: \.cghidEventTap\)/);
  assert.match(host, /if let restore \{ restorePointerAfterCancellation\(to: restore\) \}/);
  assert.match(host, /mouseType: \.mouseMoved/);
  assert.match(host, /CGWarpMouseCursorPosition\(point\)/);
  assert.match(host, /mouseType: \.leftMouseDragged/);
  assert.match(host, /private func restorePointerAfterCancellation\(to point: CGPoint\)/);
  assert.match(host, /event\.flags = \[\]/);
  assert.match(host, /mouseEventButtonNumber, value: 0/);
  assert.match(host, /mouseEventClickState, value: 1/);
  assert.match(host, /leftMouseDown/);
  assert.match(host, /leftMouseUp/);
  assert.match(host, /signal\(SIGTERM, SIG_IGN\)/);
  assert.match(host, /terminateSource\.setEventHandler/);
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
  assert.match(fixture, /scrollView\.accessibilityFrame\(\)/);
  assert.doesNotMatch(fixture, /let textFrame = textView\.accessibilityFrame\(\)/);
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

test("macOS secure-system-UI pointer capability stays on the exact-window Human-only backend", () => {
  const host = source("experiments/thin-takeover-runtime/Sources/takeover-webrtc-host/main.swift");
  const acceptance = source("experiments/thin-takeover-runtime/scripts/macos-secure-ui-window-acceptance.mts");
  const architecture = source("docs/architecture.md");

  assert.match(host, /CGEventSource\(stateID: \.combinedSessionState\)/);
  assert.match(host, /guard activateTargetWindowForInput\(processID: activeProcessID, inputBounds: activeInputBounds\) else/);
  assert.match(host, /event\.post\(tap: \.cghidEventTap\)/);
  assert.match(host, /MacOSExactWindowInput\.activate\(processID: processID, inputBounds: inputBounds\)/);
  assert.doesNotMatch(host, /CGEventSource\(stateID: \.hidSystemState\)/);

  assert.match(acceptance, /target: \{ processId: TARGET_PID \}/);
  assert.match(acceptance, /inputPolicy: \{ tap: true, scroll: false, text: false, key: false \}/);
  assert.match(acceptance, /Refusing secure-UI LAN acceptance while TURN credentials are present/);
  assert.doesNotMatch(acceptance, /tccutil|kickstart|screensharing|Remote Management|password/i);

  assert.match(architecture, /there is \*\*no hidden secure-UI fallback\*\*/i);
  assert.match(architecture, /separate, explicitly reviewed escalation/);
});

test("macOS successor-window lineage stays same-process, explicit, and desktop-free", () => {
  const adapter = source("src/window-takeover/window-handoff-adapter.ts");
  const core = source("src/window-takeover/window-handoff-core.ts");
  const exact = source("experiments/thin-takeover-runtime/Sources/TakeoverMacOSWindow/ExactWindowSurface.swift");
  const host = source("experiments/thin-takeover-runtime/Sources/takeover-webrtc-host/main.swift");
  const acceptance = source("experiments/thin-takeover-runtime/scripts/macos-window-lineage-acceptance.mts");
  const wssAcceptance = source("experiments/thin-takeover-runtime/scripts/macos-wss-window-lineage-acceptance.mts");
  const wssSurface = source("src/browser-takeover/macos-websocket-window-surface.ts");
  const linux = source("src/browser-takeover/linux-webrtc-host-cli.ts");

  assert.match(adapter, /successorWindowPolicy\?: WindowHandoffSuccessorPolicy/);
  assert.match(core, /env\.TAKEOVER_WEBRTC_WINDOW_LINEAGE = "same_process_successor"/);
  assert.match(core, /transitionWindowMs < 100 \|\| transitionWindowMs > 2_000/);
  assert.match(exact, /candidate\.processID == targetProcessID/);
  assert.match(exact, /!knownWindowIDs\.contains\(candidate\.windowID\)/);
  assert.match(exact, /eligible\.count == 1/);
  assert.match(exact, /candidate\.layer == 0/);
  assert.match(exact, /candidate\.isFocused && \(candidate\.isModal \|\| candidate\.isDialog\)/);
  assert.match(host, /selectedLineageCaptureSurface/);
  assert.match(host, /MacOSWindowLineage\.isSupportedSurface\(candidate\)/);
  assert.match(exact, /predecessorWindowID/);
  assert.match(host, /onScreenWindowsOnly: false/);
  assert.match(host, /visibility change must never make a pre-existing window/);
  assert.match(host, /authority\.fenceForTransition\(\)/);
  assert.match(host, /snapshotForFrame\(\)/);
  assert.match(host, /frameTokenIsCurrent/);
  assert.match(host, /activeTarget\.map\(revalidateLineageTarget\)/);
  assert.match(host, /return MacOSWindowLineage\.isSupportedSurface\(candidate\)/);
  assert.match(host, /writer\.submitFrame\(record, stillValid: frameStillValid\)/);
  assert.match(host, /stream\.updateContentFilter\(surface\.filter\)/);
  assert.match(host, /stream\.updateConfiguration\(configuration\)/);
  assert.match(host, /successor_stage=/);
  assert.doesNotMatch(host, /Screen Sharing|Remote Management|screensharing|kickstart/);
  assert.match(acceptance, /successorWindowPolicy: \{ mode: "same_process", transitionWindowMs: 1_200 \}/);
  assert.match(acceptance, /inputPolicy: \{ tap: true, scroll: false, text: false, key: false \}/);
  assert.match(wssAcceptance, /successorWindowPolicy: \{ mode: "same_process", transitionWindowMs: 1_200 \}/);
  assert.match(wssAcceptance, /host_successor_admitted/);
  assert.match(wssSurface, /TAKEOVER_WEBRTC_WINDOW_LINEAGE = "same_process_successor"/);
  assert.match(wssSurface, /host_successor_\$\{successorStage\}/);
  assert.match(linux, /successor-window lineage is not supported by the Linux WebRTC host/);
});

test("Window text media profile raises only the Window quality ceiling without changing Browser or backpressure", () => {
  const adapter = source("src/window-takeover/window-handoff-adapter.ts");
  const browser = source("src/browser-takeover/browser-handoff-adapter.ts");
  const core = source("src/window-takeover/window-handoff-core.ts");
  const policy = source("experiments/thin-takeover-runtime/Sources/TakeoverMacOSWindow/MediaPolicy.swift");
  const host = source("experiments/thin-takeover-runtime/Sources/takeover-webrtc-host/main.swift");
  const runtime = source("src/browser-takeover/webrtc-runtime.ts");
  const acceptance = source("experiments/thin-takeover-runtime/scripts/macos-window-media-quality-acceptance.mts");

  assert.match(adapter, /new WindowHandoffCore\(\{ \.\.\.config, mediaProfile: "window_text" \}\)/);
  assert.doesNotMatch(browser, /mediaProfile/);
  assert.match(core, /TAKEOVER_WEBRTC_MEDIA_PROFILE = mediaProfile/);
  assert.match(policy, /case standard/);
  assert.match(policy, /ceiling = \(1_280, 720\)/);
  assert.match(policy, /bitrate = 3_000_000/);
  assert.match(policy, /case \.windowText/);
  assert.match(policy, /ceiling = \(1_920, 1_080\)/);
  assert.match(policy, /bitrate = 5_000_000/);
  assert.match(policy, /speedPriority = false/);
  assert.match(host, /MacOSWindowMediaPolicyResolver\.resolve/);
  assert.match(host, /averageBitrate: mediaPolicy\.averageBitrate/);
  assert.match(host, /prioritizeEncodingSpeedOverQuality: mediaPolicy\.prioritizeEncodingSpeedOverQuality/);
  assert.match(host, /minimumFrameInterval = CMTime\(value: 1, timescale: 30\)/);
  assert.match(host, /FrameAdmissionGate\(maxInFlight: 1\)/);
  assert.match(runtime, /await sender\.sendRtp\(/);
  assert.match(runtime, /pendingFrame/);
  assert.match(acceptance, /inputPolicy: \{ tap: false, scroll: false, text: false, key: false \}/);
  assert.match(acceptance, /Refusing direct media-quality LAN acceptance while TURN credentials are present/);
  assert.doesNotMatch(acceptance, /kind: "tap"|kind: "text"|tccutil|password/i);
});

test("macOS LocalAuthentication initial secure Window admission stays explicit and system-identity bound", () => {
  const adapter = source("src/window-takeover/window-handoff-adapter.ts");
  const core = source("src/window-takeover/window-handoff-core.ts");
  const exact = source("experiments/thin-takeover-runtime/Sources/TakeoverMacOSWindow/ExactWindowSurface.swift");
  const host = source("experiments/thin-takeover-runtime/Sources/takeover-webrtc-host/main.swift");

  assert.match(adapter, /initialSecureWindowPolicy\?: WindowHandoffInitialSecureWindowPolicy/);
  assert.match(adapter, /mode: "macos_local_authentication"/);
  assert.match(core, /TAKEOVER_WEBRTC_INITIAL_SECURE_WINDOW = initialSecureWindowPolicy\.mode/);
  assert.match(core, /LocalAuthentication Window Handoff permits Human tap plus secure text\/backspace only/);
  assert.match(core, /request\.target\.windowId !== undefined/);
  assert.match(exact, /com\.apple\.LocalAuthentication\.UIAgent/);
  assert.match(exact, /com\.apple\.LocalAuthentication\.PasscodeDialog/);
  assert.match(exact, /window\.layer != 0/);
  assert.match(exact, /window\.isFocused/);
  assert.match(exact, /window\.isMain/);
  assert.match(exact, /eligible\.count == 1/);
  assert.match(exact, /MacOSLocalAuthenticationWindowInput/);
  assert.match(exact, /kAXFocusedWindowAttribute/);
  assert.match(host, /TAKEOVER_WEBRTC_INITIAL_SECURE_WINDOW/);
  assert.match(host, /MacOSLocalAuthenticationWindowInput\.verifyFocusedSecureTextField\(/);
  assert.match(host, /initialSecureWindowPolicy == \.macosLocalAuthentication[\s\S]*key == "Backspace"/);
  assert.match(host, /text\.utf8\.count <= 256/);
  assert.doesNotMatch(host, /MCP_HANDOFF_DIAGNOSTIC[^\n]*\\\\(text\\\\)/);
  assert.match(host, /MacOSLocalAuthenticationWindowCapture\.resolve/);
  assert.match(host, /MacOSLocalAuthenticationWindowInput\.verifyFocused/);
  assert.doesNotMatch(exact, /layer >= 0/);
});
