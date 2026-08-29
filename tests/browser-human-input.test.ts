import assert from "node:assert/strict";
import test from "node:test";
import {
  browserMobileKeyboardAfterRemoteTap,
  browserScrollDeltaY,
  browserTextReplacementDelta
} from "../src/browser-takeover/browser-human-input.js";

test("Browser Human Input replaces an IME preedit instead of appending the committed text", () => {
  assert.deepEqual(browserTextReplacementDelta("てす", "テスト"), { backspaces: 2, insert: "テスト" });
  assert.deepEqual(browserTextReplacementDelta("test", "testing"), { backspaces: 0, insert: "ing" });
  assert.deepEqual(browserTextReplacementDelta("😀a", "😀b"), { backspaces: 1, insert: "b" });
});

test("Browser Human Input keeps scroll sign aligned with the established WebRTC gesture path", () => {
  assert.equal(browserScrollDeltaY(40), 120);
  assert.equal(browserScrollDeltaY(-40), -120);
  assert.equal(browserScrollDeltaY(10_000), 2_000);
  assert.equal(browserScrollDeltaY(Number.NaN), 0);
});

test("Browser Human Input keeps an explicitly opened mobile keyboard session across remote taps", () => {
  assert.equal(browserMobileKeyboardAfterRemoteTap("closed"), "closed");
  assert.equal(browserMobileKeyboardAfterRemoteTap("explicit"), "explicit");
});
