import assert from "node:assert/strict";
import test from "node:test";
import {
  browserHumanInputClientSource,
  browserImeInputEventIsCompositionControlled,
  browserImeKeyboardEventIsCompositionControlled,
  browserImeNextCompositionPhase,
  type BrowserImeCompositionPhase,
  browserMobileKeyboardAfterRemoteTap,
  browserPhysicalSwipeScrollDelta,
  browserScrollDelta,
  browserScrollDeltaY,
  browserTextReplacementDelta,
  browserTextReplacementMutation,
  browserWebRtcScrollDelta
} from "../src/browser-takeover/browser-human-input.js";

test("Browser Human Input replaces an IME preedit instead of appending the committed text", () => {
  assert.deepEqual(browserTextReplacementDelta("てす", "テスト"), { backspaces: 2, insert: "テスト" });
  assert.deepEqual(browserTextReplacementDelta("test", "testing"), { backspaces: 0, insert: "ing" });
  assert.deepEqual(browserTextReplacementDelta("😀a", "😀b"), { backspaces: 1, insert: "b" });
});

test("Browser Human Input normalizes third-party insertText truncation without changing composition semantics", () => {
  assert.deepEqual(
    browserTextReplacementMutation("", "テス", "insertText", "テスト"),
    { backspaces: 0, insert: "テスト", next: "テスト" }
  );
  assert.deepEqual(
    browserTextReplacementMutation("abcde", "abXYde", "insertText", "XY"),
    { backspaces: 3, insert: "XYde", next: "abXYde" },
    "selection-style middle replacement must rebuild the changed suffix instead of assuming append-only input"
  );
  assert.deepEqual(
    browserTextReplacementMutation("", "テス", "insertFromComposition", "テスト"),
    { backspaces: 0, insert: "テス", next: "テス" },
    "system composition commits remain DOM-authoritative"
  );
});

test("Browser Human Input keeps Safari IME confirmation inside a settling phase", () => {
  let phase: BrowserImeCompositionPhase = "idle";
  phase = browserImeNextCompositionPhase(phase, "composition_start");
  assert.equal(phase, "composing");
  assert.equal(browserImeInputEventIsCompositionControlled(phase, true), true);

  phase = browserImeNextCompositionPhase(phase, "composition_end");
  assert.equal(phase, "settling");
  assert.equal(
    browserImeKeyboardEventIsCompositionControlled(phase, false, 13),
    true,
    "Safari confirmation Enter after compositionend must stay local"
  );
  assert.equal(browserImeInputEventIsCompositionControlled(phase, false), true);

  phase = browserImeNextCompositionPhase(phase, "settled");
  assert.equal(phase, "idle");
  assert.equal(browserImeKeyboardEventIsCompositionControlled(phase, false, 13), false);
  assert.equal(browserImeInputEventIsCompositionControlled(phase, false), false);
  assert.equal(
    browserImeKeyboardEventIsCompositionControlled(phase, false, 229),
    true,
    "legacy Safari/WebKit IME keyCode stays composition-controlled"
  );
  assert.equal(browserImeNextCompositionPhase("idle", "composition_end"), "settling");
});

test("Browser Human Input maps swipe direction to natural remote page scrolling", () => {
  assert.equal(browserScrollDeltaY(40), -120);
  assert.equal(browserScrollDeltaY(-40), 120);
  assert.equal(browserScrollDeltaY(10_000), -2_000);
  assert.equal(browserScrollDeltaY(Number.NaN), 0);
  assert.equal(browserScrollDelta(40), -120);
  assert.equal(browserScrollDelta(-40, 2), 80);
  assert.equal(browserWebRtcScrollDelta(40), 120);
  assert.equal(browserWebRtcScrollDelta(-40), -120);
});

test("Browser Human Input keeps an explicitly opened mobile keyboard session across remote taps", () => {
  assert.equal(browserMobileKeyboardAfterRemoteTap("closed"), "closed");
  assert.equal(browserMobileKeyboardAfterRemoteTap("explicit"), "explicit");
});

test("Browser Human Input emits browser-safe shared helper source", () => {
  const source = browserHumanInputClientSource();
  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /browserImeNextCompositionPhase/);
  assert.match(source, /browserImeKeyboardEventIsCompositionControlled/);
  assert.match(source, /browserImeInputEventIsCompositionControlled/);
  assert.match(source, /browserTextReplacementDelta/);
  assert.match(source, /browserScrollDelta/);
  assert.match(source, /browserScrollDeltaY/);
  assert.match(source, /browserWebRtcScrollDelta/);
  assert.doesNotMatch(source, /credential|token|principal|windowId|processId/i);
});
