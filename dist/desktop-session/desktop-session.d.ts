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
export declare const PHYSICAL_DISPLAY_CAPABILITIES: DesktopDisplayCapabilities;
export declare const PHYSICAL_DISPLAY_BACKEND: DesktopDisplayBackendDescriptor;
export declare class DesktopSessionBoundaryError extends Error {
    readonly code: "DESKTOP_SESSION_TARGET_INVALID" | "DESKTOP_SESSION_CLOSED" | "DESKTOP_VIEWER_ALREADY_ATTACHED" | "DESKTOP_VIEWER_GENERATION_STALE" | "DESKTOP_VIEWER_LAYOUT_INVALID" | "DESKTOP_VIEWER_POINT_OUTSIDE_SURFACE" | "DESKTOP_DISPLAY_RESIZE_UNSUPPORTED";
    constructor(code: "DESKTOP_SESSION_TARGET_INVALID" | "DESKTOP_SESSION_CLOSED" | "DESKTOP_VIEWER_ALREADY_ATTACHED" | "DESKTOP_VIEWER_GENERATION_STALE" | "DESKTOP_VIEWER_LAYOUT_INVALID" | "DESKTOP_VIEWER_POINT_OUTSIDE_SURFACE" | "DESKTOP_DISPLAY_RESIZE_UNSUPPORTED", message: string);
}
/**
 * One Handoff-owned view of a persistent application/session + physical display binding.
 *
 * The display remains attached while transport/viewer generations rotate. `close()` ends only this
 * Handoff boundary; it does not terminate the consumer-owned OS/application session.
 */
export declare class DesktopSessionDisplayBoundary {
    #private;
    constructor(target: DesktopSessionTargetBinding);
    attachViewer(generation: number): DesktopViewerAttachment;
    detachViewer(attachment: Pick<DesktopViewerAttachment, "generation">): void;
    /** Idempotent authority/transport teardown hook. It never closes the persistent session boundary. */
    detachCurrentViewer(): void;
    /** Fail closed if a later transport attempts to retarget the existing Desktop Session implicitly. */
    assertSameTarget(target: DesktopSessionTargetBinding): void;
    /**
     * Physical display resize is intentionally unsupported in the v0.4.x boundary.
     * Viewer fit/zoom/pan is separate and cannot mutate monitor/window geometry through this API.
     */
    requestDisplayResize(width: number, height: number): never;
    close(): void;
    snapshot(): DesktopSessionSnapshot;
}
export declare function createPhysicalDesktopSessionBoundary(target: DesktopSessionTargetBinding): DesktopSessionDisplayBoundary;
/**
 * Resolve viewer-only fit/actual/adaptive geometry. `adaptive` remains viewer-side for the current
 * physical backend; it never requests or implies an OS display resize.
 */
export declare function resolveDesktopViewerLayout(request: DesktopViewerLayoutRequest): DesktopViewerLayout;
/** Map a viewer point back to one normalized point on the already-authorized bounded surface. */
export declare function desktopViewerPointToNormalizedSurface(layout: DesktopViewerLayout, point: DesktopViewerPoint): DesktopViewerPoint;
//# sourceMappingURL=desktop-session.d.ts.map