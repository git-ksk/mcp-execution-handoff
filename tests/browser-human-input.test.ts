import assert from "node:assert/strict";
import test from "node:test";
import {
  browserHumanInputClientSource,
  browserMobileKeyboardAfterRemoteTap,
  browserScrollDelta,
  browserScrollDeltaY,
  browserTextReplacementDelta
} from "../src/browser-takeover/browser-human-input.js";

test("Browser Human Input replaces an IME preedit instead of appending the committed text", () => {
  assert.deepEqual(browserTextReplacementDelta("てす", "テスト"), { backspaces: 2, insert: "テスト" });
  assert.deepEqual(browserTextReplacementDelta("test", "testing"), { backspaces: 0, insert: "ing" });
  assert.deepEqual(browserTextReplacementDelta("😀a", "😀b"), { backspaces: 1, insert: "b" });
});

test("Browser Human Input maps swipe direction to natural remote page scrolling", () => {
  assert.equal(browserScrollDeltaY(40), -120);
  assert.equal(browserScrollDeltaY(-40), 120);
  assert.equal(browserScrollDeltaY(10_000), -2_000);
  assert.equal(browserScrollDeltaY(Number.NaN), 0);
  assert.equal(browserScrollDelta(40), -120);
  assert.equal(browserScrollDelta(-40, 2), 80);
});

test("Browser Human Input keeps an explicitly opened mobile keyboard session across remote taps", () => {
  assert.equal(browserMobileKeyboardAfterRemoteTap("closed"), "closed");
  assert.equal(browserMobileKeyboardAfterRemoteTap("explicit"), "explicit");
});

test("Browser Human Input emits browser-safe shared helper source", () => {
  const source = browserHumanInputClientSource();
  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /browserTextReplacementDelta/);
  assert.match(source, /browserScrollDelta/);
  assert.match(source, /browserScrollDeltaY/);
  assert.doesNotMatch(source, /credential|token|principal|windowId|processId/i);
});
