import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_BROWSER_HANDOFF_VIEW_SCALE,
  browserHandoffPinchTransform,
  normalizeBrowserHandoffViewTransform
} from "../src/browser-takeover/mobile-view-transform.js";

test("mobile Browser Handoff view transform keeps zoom and pan bounded inside the exact rendered surface", () => {
  assert.deepEqual(normalizeBrowserHandoffViewTransform(1, 999, -999, 390, 844), {
    scale: 1,
    panX: 0,
    panY: 0
  });
  assert.deepEqual(normalizeBrowserHandoffViewTransform(9, 9999, -9999, 390, 844), {
    scale: MAX_BROWSER_HANDOFF_VIEW_SCALE,
    panX: 585,
    panY: -1266
  });
  assert.deepEqual(normalizeBrowserHandoffViewTransform(Number.NaN, Number.NaN, Number.NaN, 0, 844), {
    scale: 1,
    panX: 0,
    panY: 0
  });
});

test("pinch transform preserves the touched focal point while scaling and remains bounded", () => {
  const centered = browserHandoffPinchTransform({
    startDistance: 100,
    startScale: 1,
    startPanX: 0,
    startPanY: 0,
    startMidX: 195,
    startMidY: 422,
    centerX: 195,
    centerY: 422
  }, 200, 195, 422, 390, 844);
  assert.deepEqual(centered, { scale: 2, panX: 0, panY: 0 });

  const focal = browserHandoffPinchTransform({
    startDistance: 100,
    startScale: 1,
    startPanX: 0,
    startPanY: 0,
    startMidX: 120,
    startMidY: 300,
    centerX: 195,
    centerY: 422
  }, 200, 130, 320, 390, 844);
  assert.deepEqual(focal, { scale: 2, panX: 85, panY: 142 });
});
