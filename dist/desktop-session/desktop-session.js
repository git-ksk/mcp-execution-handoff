/**
 * Internal Desktop Session / Display Backend boundary.
 *
 * This is deliberately not a package export in v0.4.x. It separates one persistent application
 * session from its display backend and from short-lived Human viewer/transport generations without
 * introducing Desktop mutation authority. The initial backend is the existing physical bounded
 * Window path; virtual/remote backends remain follow-up work.
 */
export const PHYSICAL_DISPLAY_CAPABILITIES = Object.freeze({
    viewerScaling: true,
    dynamicDisplayResize: false
});
export const PHYSICAL_DISPLAY_BACKEND = Object.freeze({
    kind: "physical",
    capabilities: PHYSICAL_DISPLAY_CAPABILITIES
});
export class DesktopSessionBoundaryError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "DesktopSessionBoundaryError";
    }
}
/**
 * One Handoff-owned view of a persistent application/session + physical display binding.
 *
 * The display remains attached while transport/viewer generations rotate. `close()` ends only this
 * Handoff boundary; it does not terminate the consumer-owned OS/application session.
 */
export class DesktopSessionDisplayBoundary {
    #target;
    #closed = false;
    #viewerAttached = false;
    #viewerGeneration = 0;
    constructor(target) {
        if (!validTarget(target)) {
            throw new DesktopSessionBoundaryError("DESKTOP_SESSION_TARGET_INVALID", "Desktop Session physical backend requires one bounded Window target");
        }
        this.#target = Object.freeze({ ...target });
    }
    attachViewer(generation) {
        if (this.#closed) {
            throw new DesktopSessionBoundaryError("DESKTOP_SESSION_CLOSED", "Desktop Session is closed");
        }
        if (!Number.isSafeInteger(generation) || generation <= this.#viewerGeneration || generation <= 0) {
            throw new DesktopSessionBoundaryError("DESKTOP_VIEWER_GENERATION_STALE", "Desktop viewer generation is stale");
        }
        if (this.#viewerAttached) {
            throw new DesktopSessionBoundaryError("DESKTOP_VIEWER_ALREADY_ATTACHED", "Desktop Session already has an active Human viewer generation");
        }
        this.#viewerGeneration = generation;
        this.#viewerAttached = true;
        return Object.freeze({ generation });
    }
    detachViewer(attachment) {
        if (!this.#viewerAttached || attachment.generation !== this.#viewerGeneration) {
            throw new DesktopSessionBoundaryError("DESKTOP_VIEWER_GENERATION_STALE", "Desktop viewer generation is stale");
        }
        this.#viewerAttached = false;
    }
    /** Idempotent authority/transport teardown hook. It never closes the persistent session boundary. */
    detachCurrentViewer() {
        this.#viewerAttached = false;
    }
    /** Fail closed if a later transport attempts to retarget the existing Desktop Session implicitly. */
    assertSameTarget(target) {
        if (!validTarget(target) || !sameTarget(this.#target, target)) {
            throw new DesktopSessionBoundaryError("DESKTOP_SESSION_TARGET_INVALID", "Desktop Session target cannot change implicitly");
        }
    }
    /**
     * Physical display resize is intentionally unsupported in the v0.4.x boundary.
     * Viewer fit/zoom/pan is separate and cannot mutate monitor/window geometry through this API.
     */
    requestDisplayResize(width, height) {
        if (!validDimension(width) || !validDimension(height)) {
            throw new DesktopSessionBoundaryError("DESKTOP_VIEWER_LAYOUT_INVALID", "Desktop display resize dimensions are invalid");
        }
        throw new DesktopSessionBoundaryError("DESKTOP_DISPLAY_RESIZE_UNSUPPORTED", "Physical display backend does not support dynamic display resize");
    }
    close() {
        this.#viewerAttached = false;
        this.#closed = true;
    }
    snapshot() {
        return {
            version: 1,
            lifecycle: this.#closed ? "closed" : "active",
            displayBackend: PHYSICAL_DISPLAY_BACKEND.kind,
            displayAttached: !this.#closed,
            viewerAttached: this.#viewerAttached,
            viewerGeneration: this.#viewerGeneration,
            capabilities: PHYSICAL_DISPLAY_BACKEND.capabilities
        };
    }
}
export function createPhysicalDesktopSessionBoundary(target) {
    return new DesktopSessionDisplayBoundary(target);
}
/**
 * Resolve viewer-only fit/actual/adaptive geometry. `adaptive` remains viewer-side for the current
 * physical backend; it never requests or implies an OS display resize.
 */
export function resolveDesktopViewerLayout(request) {
    if (!validViewerMode(request.mode)
        || !validDimension(request.surfaceWidth)
        || !validDimension(request.surfaceHeight)
        || !validDimension(request.viewportWidth)
        || !validDimension(request.viewportHeight)) {
        throw new DesktopSessionBoundaryError("DESKTOP_VIEWER_LAYOUT_INVALID", "Desktop viewer layout is invalid");
    }
    const zoom = request.zoom ?? 1;
    const panX = request.panX ?? 0;
    const panY = request.panY ?? 0;
    if (!Number.isFinite(zoom) || zoom < 1 || zoom > 4 || !Number.isFinite(panX) || !Number.isFinite(panY)) {
        throw new DesktopSessionBoundaryError("DESKTOP_VIEWER_LAYOUT_INVALID", "Desktop viewer transform is invalid");
    }
    const baseScale = request.mode === "actual_size"
        ? 1
        : Math.min(request.viewportWidth / request.surfaceWidth, request.viewportHeight / request.surfaceHeight);
    const renderedWidth = request.surfaceWidth * baseScale * zoom;
    const renderedHeight = request.surfaceHeight * baseScale * zoom;
    const maxPanX = Math.max(0, (renderedWidth - request.viewportWidth) / 2);
    const maxPanY = Math.max(0, (renderedHeight - request.viewportHeight) / 2);
    const boundedPanX = clamp(panX, -maxPanX, maxPanX);
    const boundedPanY = clamp(panY, -maxPanY, maxPanY);
    return {
        mode: request.mode,
        surfaceWidth: request.surfaceWidth,
        surfaceHeight: request.surfaceHeight,
        viewportWidth: request.viewportWidth,
        viewportHeight: request.viewportHeight,
        baseScale,
        zoom,
        renderedWidth,
        renderedHeight,
        offsetX: (request.viewportWidth - renderedWidth) / 2 + boundedPanX,
        offsetY: (request.viewportHeight - renderedHeight) / 2 + boundedPanY,
        displayResizeNegotiated: false
    };
}
/** Map a viewer point back to one normalized point on the already-authorized bounded surface. */
export function desktopViewerPointToNormalizedSurface(layout, point) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)
        || !validDimension(layout.renderedWidth) || !validDimension(layout.renderedHeight)) {
        throw new DesktopSessionBoundaryError("DESKTOP_VIEWER_LAYOUT_INVALID", "Desktop viewer point is invalid");
    }
    const x = (point.x - layout.offsetX) / layout.renderedWidth;
    const y = (point.y - layout.offsetY) / layout.renderedHeight;
    if (x < 0 || x > 1 || y < 0 || y > 1) {
        throw new DesktopSessionBoundaryError("DESKTOP_VIEWER_POINT_OUTSIDE_SURFACE", "Desktop viewer point is outside the bounded surface");
    }
    return { x: cleanZero(x), y: cleanZero(y) };
}
function validTarget(target) {
    return target?.kind === "bounded_window"
        && Number.isSafeInteger(target.processId) && target.processId > 0
        && (target.windowId === undefined || (Number.isSafeInteger(target.windowId) && target.windowId > 0));
}
function sameTarget(left, right) {
    return left.kind === right.kind
        && left.processId === right.processId
        && left.windowId === right.windowId;
}
function validViewerMode(mode) {
    return mode === "fit" || mode === "actual_size" || mode === "adaptive";
}
function validDimension(value) {
    return Number.isFinite(value) && value > 0;
}
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
function cleanZero(value) {
    return Object.is(value, -0) ? 0 : value;
}
//# sourceMappingURL=desktop-session.js.map