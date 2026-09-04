/**
 * Internal Desktop Session / Display Backend boundary.
 *
 * This is deliberately not a package export in v0.4.x. It separates one persistent application
 * session from its display backend and from short-lived Human viewer/transport generations without
 * introducing Desktop mutation authority. The initial backend is the existing physical bounded
 * Window path; virtual/remote backends remain follow-up work.
 */

export type DesktopDisplayBackendKind = "physical" | "virtual" | "remote_session";
export type DesktopViewerMode = "fit" | "actual_size" | "adaptive";

export interface DesktopDisplayCapabilities {
  readonly viewerScaling: boolean;
  readonly dynamicDisplayResize: boolean;
}

/** Backend-neutral capability description. v0.4.1 ships only the physical implementation. */
export interface DesktopDisplayBackendDescriptor {
  readonly kind: DesktopDisplayBackendKind;
  readonly capabilities: DesktopDisplayCapabilities;
}

export interface DesktopSessionTargetBinding {
  readonly kind: "bounded_window";
  readonly processId: number;
  readonly windowId?: number;
}

export interface DesktopViewerAttachment {
  readonly generation: number;
}

export interface DesktopSessionSnapshot {
  readonly version: 1;
  readonly lifecycle: "active" | "closed";
  readonly displayBackend: DesktopDisplayBackendKind;
  readonly displayAttached: boolean;
  readonly viewerAttached: boolean;
  readonly viewerGeneration: number;
  readonly capabilities: DesktopDisplayCapabilities;
}

export interface DesktopViewerLayoutRequest {
  readonly mode: DesktopViewerMode;
  readonly surfaceWidth: number;
  readonly surfaceHeight: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly zoom?: number;
  readonly panX?: number;
  readonly panY?: number;
}

export interface DesktopViewerLayout {
  readonly mode: DesktopViewerMode;
  readonly surfaceWidth: number;
  readonly surfaceHeight: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly baseScale: number;
  readonly zoom: number;
  readonly renderedWidth: number;
  readonly renderedHeight: number;
  readonly offsetX: number;
  readonly offsetY: number;
  /** Physical v0.4.x never changes the underlying display to satisfy a viewer layout. */
  readonly displayResizeNegotiated: false;
}

export interface DesktopViewerPoint {
  readonly x: number;
  readonly y: number;
}

export const PHYSICAL_DISPLAY_CAPABILITIES: DesktopDisplayCapabilities = Object.freeze({
  viewerScaling: true,
  dynamicDisplayResize: false
});

export const PHYSICAL_DISPLAY_BACKEND: DesktopDisplayBackendDescriptor = Object.freeze({
  kind: "physical",
  capabilities: PHYSICAL_DISPLAY_CAPABILITIES
});

export class DesktopSessionBoundaryError extends Error {
  constructor(
    public readonly code:
      | "DESKTOP_SESSION_TARGET_INVALID"
      | "DESKTOP_SESSION_CLOSED"
      | "DESKTOP_VIEWER_ALREADY_ATTACHED"
      | "DESKTOP_VIEWER_GENERATION_STALE"
      | "DESKTOP_VIEWER_LAYOUT_INVALID"
      | "DESKTOP_VIEWER_POINT_OUTSIDE_SURFACE"
      | "DESKTOP_DISPLAY_RESIZE_UNSUPPORTED",
    message: string
  ) {
    super(message);
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
  readonly #target: DesktopSessionTargetBinding;
  #closed = false;
  #viewerAttached = false;
  #viewerGeneration = 0;

  constructor(target: DesktopSessionTargetBinding) {
    if (!validTarget(target)) {
      throw new DesktopSessionBoundaryError(
        "DESKTOP_SESSION_TARGET_INVALID",
        "Desktop Session physical backend requires one bounded Window target"
      );
    }
    this.#target = Object.freeze({ ...target });
  }

  attachViewer(generation: number): DesktopViewerAttachment {
    if (this.#closed) {
      throw new DesktopSessionBoundaryError(
        "DESKTOP_SESSION_CLOSED",
        "Desktop Session is closed"
      );
    }
    if (!Number.isSafeInteger(generation) || generation <= this.#viewerGeneration || generation <= 0) {
      throw new DesktopSessionBoundaryError(
        "DESKTOP_VIEWER_GENERATION_STALE",
        "Desktop viewer generation is stale"
      );
    }
    if (this.#viewerAttached) {
      throw new DesktopSessionBoundaryError(
        "DESKTOP_VIEWER_ALREADY_ATTACHED",
        "Desktop Session already has an active Human viewer generation"
      );
    }
    this.#viewerGeneration = generation;
    this.#viewerAttached = true;
    return Object.freeze({ generation });
  }

  detachViewer(attachment: Pick<DesktopViewerAttachment, "generation">): void {
    if (!this.#viewerAttached || attachment.generation !== this.#viewerGeneration) {
      throw new DesktopSessionBoundaryError(
        "DESKTOP_VIEWER_GENERATION_STALE",
        "Desktop viewer generation is stale"
      );
    }
    this.#viewerAttached = false;
  }

  /** Idempotent authority/transport teardown hook. It never closes the persistent session boundary. */
  detachCurrentViewer(): void {
    this.#viewerAttached = false;
  }

  /** Fail closed if a later transport attempts to retarget the existing Desktop Session implicitly. */
  assertSameTarget(target: DesktopSessionTargetBinding): void {
    if (!validTarget(target) || !sameTarget(this.#target, target)) {
      throw new DesktopSessionBoundaryError(
        "DESKTOP_SESSION_TARGET_INVALID",
        "Desktop Session target cannot change implicitly"
      );
    }
  }

  /**
   * Physical display resize is intentionally unsupported in the v0.4.x boundary.
   * Viewer fit/zoom/pan is separate and cannot mutate monitor/window geometry through this API.
   */
  requestDisplayResize(width: number, height: number): never {
    if (!validDimension(width) || !validDimension(height)) {
      throw new DesktopSessionBoundaryError(
        "DESKTOP_VIEWER_LAYOUT_INVALID",
        "Desktop display resize dimensions are invalid"
      );
    }
    throw new DesktopSessionBoundaryError(
      "DESKTOP_DISPLAY_RESIZE_UNSUPPORTED",
      "Physical display backend does not support dynamic display resize"
    );
  }

  close(): void {
    this.#viewerAttached = false;
    this.#closed = true;
  }

  snapshot(): DesktopSessionSnapshot {
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

export function createPhysicalDesktopSessionBoundary(
  target: DesktopSessionTargetBinding
): DesktopSessionDisplayBoundary {
  return new DesktopSessionDisplayBoundary(target);
}

/**
 * Resolve viewer-only fit/actual/adaptive geometry. `adaptive` remains viewer-side for the current
 * physical backend; it never requests or implies an OS display resize.
 */
export function resolveDesktopViewerLayout(request: DesktopViewerLayoutRequest): DesktopViewerLayout {
  if (!validViewerMode(request.mode)
      || !validDimension(request.surfaceWidth)
      || !validDimension(request.surfaceHeight)
      || !validDimension(request.viewportWidth)
      || !validDimension(request.viewportHeight)) {
    throw new DesktopSessionBoundaryError(
      "DESKTOP_VIEWER_LAYOUT_INVALID",
      "Desktop viewer layout is invalid"
    );
  }
  const zoom = request.zoom ?? 1;
  const panX = request.panX ?? 0;
  const panY = request.panY ?? 0;
  if (!Number.isFinite(zoom) || zoom < 1 || zoom > 4 || !Number.isFinite(panX) || !Number.isFinite(panY)) {
    throw new DesktopSessionBoundaryError(
      "DESKTOP_VIEWER_LAYOUT_INVALID",
      "Desktop viewer transform is invalid"
    );
  }

  const baseScale = request.mode === "actual_size"
    ? 1
    : Math.min(
        request.viewportWidth / request.surfaceWidth,
        request.viewportHeight / request.surfaceHeight
      );
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
export function desktopViewerPointToNormalizedSurface(
  layout: DesktopViewerLayout,
  point: DesktopViewerPoint
): DesktopViewerPoint {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)
      || !validDimension(layout.renderedWidth) || !validDimension(layout.renderedHeight)) {
    throw new DesktopSessionBoundaryError(
      "DESKTOP_VIEWER_LAYOUT_INVALID",
      "Desktop viewer point is invalid"
    );
  }
  const x = (point.x - layout.offsetX) / layout.renderedWidth;
  const y = (point.y - layout.offsetY) / layout.renderedHeight;
  if (x < 0 || x > 1 || y < 0 || y > 1) {
    throw new DesktopSessionBoundaryError(
      "DESKTOP_VIEWER_POINT_OUTSIDE_SURFACE",
      "Desktop viewer point is outside the bounded surface"
    );
  }
  return { x: cleanZero(x), y: cleanZero(y) };
}

function validTarget(target: DesktopSessionTargetBinding): boolean {
  return target?.kind === "bounded_window"
    && Number.isSafeInteger(target.processId) && target.processId > 0
    && (target.windowId === undefined || (Number.isSafeInteger(target.windowId) && target.windowId > 0));
}

function sameTarget(left: DesktopSessionTargetBinding, right: DesktopSessionTargetBinding): boolean {
  return left.kind === right.kind
    && left.processId === right.processId
    && left.windowId === right.windowId;
}

function validViewerMode(mode: DesktopViewerMode): boolean {
  return mode === "fit" || mode === "actual_size" || mode === "adaptive";
}

function validDimension(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function cleanZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}
