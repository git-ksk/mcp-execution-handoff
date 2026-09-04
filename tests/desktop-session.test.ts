import assert from "node:assert/strict";
import test from "node:test";
import {
  DesktopSessionBoundaryError,
  createPhysicalDesktopSessionBoundary,
  desktopViewerPointToNormalizedSurface,
  resolveDesktopViewerLayout
} from "../src/desktop-session/desktop-session.js";

const TARGET = { kind: "bounded_window", processId: 4242, windowId: 7331 } as const;

test("physical Desktop Session persists across viewer disconnect/reconnect while attachment generation rotates", () => {
  const session = createPhysicalDesktopSessionBoundary(TARGET);
  const first = session.attachViewer(1);
  assert.deepEqual(session.snapshot(), {
    version: 1,
    lifecycle: "active",
    displayBackend: "physical",
    displayAttached: true,
    viewerAttached: true,
    viewerGeneration: 1,
    capabilities: { viewerScaling: true, dynamicDisplayResize: false }
  });

  session.detachViewer(first);
  assert.equal(session.snapshot().displayAttached, true);
  assert.equal(session.snapshot().viewerAttached, false);

  session.attachViewer(2);
  assert.equal(session.snapshot().viewerGeneration, 2);
  assert.equal(session.snapshot().lifecycle, "active");
  session.close();
  assert.deepEqual(session.snapshot(), {
    version: 1,
    lifecycle: "closed",
    displayBackend: "physical",
    displayAttached: false,
    viewerAttached: false,
    viewerGeneration: 2,
    capabilities: { viewerScaling: true, dynamicDisplayResize: false }
  });
});

test("Desktop Session viewer generation and implicit retargeting fail closed", () => {
  const session = createPhysicalDesktopSessionBoundary(TARGET);
  const first = session.attachViewer(1);
  session.detachViewer(first);
  session.attachViewer(2);

  assert.throws(
    () => session.detachViewer(first),
    (error: unknown) => error instanceof DesktopSessionBoundaryError
      && error.code === "DESKTOP_VIEWER_GENERATION_STALE"
  );
  assert.throws(
    () => session.attachViewer(2),
    (error: unknown) => error instanceof DesktopSessionBoundaryError
      && error.code === "DESKTOP_VIEWER_GENERATION_STALE"
  );
  assert.throws(
    () => session.assertSameTarget({ ...TARGET, windowId: 7332 }),
    (error: unknown) => error instanceof DesktopSessionBoundaryError
      && error.code === "DESKTOP_SESSION_TARGET_INVALID"
  );
});

test("physical display resize is unsupported while viewer scaling remains explicit", () => {
  const session = createPhysicalDesktopSessionBoundary(TARGET);
  assert.deepEqual(session.snapshot().capabilities, {
    viewerScaling: true,
    dynamicDisplayResize: false
  });
  assert.throws(
    () => session.requestDisplayResize(1920, 1080),
    (error: unknown) => error instanceof DesktopSessionBoundaryError
      && error.code === "DESKTOP_DISPLAY_RESIZE_UNSUPPORTED"
  );
});

test("viewer fit actual-size and adaptive layouts never negotiate physical display resize", () => {
  const fit = resolveDesktopViewerLayout({
    mode: "fit",
    surfaceWidth: 800,
    surfaceHeight: 600,
    viewportWidth: 400,
    viewportHeight: 400
  });
  assert.equal(fit.baseScale, 0.5);
  assert.equal(fit.renderedWidth, 400);
  assert.equal(fit.renderedHeight, 300);
  assert.equal(fit.offsetX, 0);
  assert.equal(fit.offsetY, 50);
  assert.equal(fit.displayResizeNegotiated, false);
  assert.deepEqual(desktopViewerPointToNormalizedSurface(fit, { x: 200, y: 200 }), { x: 0.5, y: 0.5 });

  const actual = resolveDesktopViewerLayout({
    mode: "actual_size",
    surfaceWidth: 800,
    surfaceHeight: 600,
    viewportWidth: 400,
    viewportHeight: 400
  });
  assert.equal(actual.baseScale, 1);
  assert.deepEqual(desktopViewerPointToNormalizedSurface(actual, { x: 200, y: 200 }), { x: 0.5, y: 0.5 });

  const adaptive = resolveDesktopViewerLayout({
    mode: "adaptive",
    surfaceWidth: 800,
    surfaceHeight: 600,
    viewportWidth: 400,
    viewportHeight: 400
  });
  assert.equal(adaptive.baseScale, fit.baseScale);
  assert.equal(adaptive.displayResizeNegotiated, false);
});

test("viewer coordinate transforms reject points outside the authorized rendered surface", () => {
  const layout = resolveDesktopViewerLayout({
    mode: "fit",
    surfaceWidth: 800,
    surfaceHeight: 600,
    viewportWidth: 400,
    viewportHeight: 400
  });
  assert.throws(
    () => desktopViewerPointToNormalizedSurface(layout, { x: 200, y: 25 }),
    (error: unknown) => error instanceof DesktopSessionBoundaryError
      && error.code === "DESKTOP_VIEWER_POINT_OUTSIDE_SURFACE"
  );
});

test("Desktop Session snapshot is content-free and omits process/window identity", () => {
  const session = createPhysicalDesktopSessionBoundary(TARGET);
  session.attachViewer(1);
  const encoded = JSON.stringify(session.snapshot());
  assert.doesNotMatch(encoded, /4242|7331|process|window|principal|intervention|locator|credential/i);
});
