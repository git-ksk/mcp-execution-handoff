import assert from "node:assert/strict";
import test from "node:test";
import {
  BoundedWindowSelectionError,
  normalizedPointInWindow,
  rectContains,
  scaledEvenWindowSize,
  selectExactBoundedWindow
} from "../src/target-surface/os-window.js";

test("OS window primitives select exactly one eligible bounded window", () => {
  assert.deepEqual(
    selectExactBoundedWindow([
      { id: 7, x: 10, y: 20, width: 900, height: 700 }
    ]),
    { id: 7, x: 10, y: 20, width: 900, height: 700 }
  );

  assert.throws(
    () => selectExactBoundedWindow([{ id: 7, x: 0, y: 0, width: 100, height: 80 }]),
    (error: unknown) => error instanceof BoundedWindowSelectionError && error.code === "WINDOW_NONE"
  );

  assert.throws(
    () => selectExactBoundedWindow([
      { id: 7, x: 0, y: 0, width: 900, height: 700 },
      { id: 8, x: 100, y: 100, width: 900, height: 700 }
    ]),
    (error: unknown) => error instanceof BoundedWindowSelectionError && error.code === "WINDOW_AMBIGUOUS"
  );
});

test("OS window primitives reject invalid geometry instead of widening the target", () => {
  assert.throws(
    () => selectExactBoundedWindow([{ id: 7, x: 0, y: 0, width: Number.NaN, height: 700 }]),
    (error: unknown) => error instanceof BoundedWindowSelectionError && error.code === "WINDOW_NONE"
  );

  assert.equal(
    rectContains(
      { id: "display", x: 0, y: 0, width: 1920, height: 1080 },
      { id: "window", x: 100, y: 100, width: 900, height: 700 }
    ),
    true
  );
  assert.equal(
    rectContains(
      { id: "display", x: 0, y: 0, width: 1920, height: 1080 },
      { id: "window", x: 1500, y: 900, width: 900, height: 700 }
    ),
    false
  );
});

test("OS window primitives map normalized Human input inside the exact target bounds", () => {
  const geometry = { id: 7, x: 100, y: 200, width: 1000, height: 800 };
  assert.deepEqual(normalizedPointInWindow(geometry, 0, 0), { x: 100, y: 200 });
  assert.deepEqual(normalizedPointInWindow(geometry, 0.5, 0.5), { x: 600, y: 600 });
  assert.deepEqual(normalizedPointInWindow(geometry, 1, 1), { x: 1099, y: 999 });
  assert.throws(() => normalizedPointInWindow(geometry, -0.01, 0.5));
  assert.throws(() => normalizedPointInWindow(geometry, 0.5, 1.01));
});

test("OS window primitives preserve aspect ratio under bounded even-sized capture limits", () => {
  assert.deepEqual(scaledEvenWindowSize(1920, 1080, 1280, 720), { width: 1280, height: 720 });
  assert.deepEqual(scaledEvenWindowSize(901, 701, 1280, 720), { width: 900, height: 700 });
  assert.deepEqual(scaledEvenWindowSize(800, 600, 1920, 1080), { width: 800, height: 600 });
  assert.throws(() => scaledEvenWindowSize(0, 600, 1280, 720));
});
