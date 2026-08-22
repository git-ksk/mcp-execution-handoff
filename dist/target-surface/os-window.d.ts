export interface BoundedWindowGeometry<TId = number> {
    id: TId;
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface BoundedWindowSize {
    width: number;
    height: number;
}
export interface BoundedWindowPoint {
    x: number;
    y: number;
}
export interface BoundedWindowSelectionOptions {
    minWidth?: number;
    minHeight?: number;
}
export declare class BoundedWindowSelectionError extends Error {
    readonly code: "WINDOW_NONE" | "WINDOW_AMBIGUOUS";
    constructor(code: "WINDOW_NONE" | "WINDOW_AMBIGUOUS", message: string);
}
/**
 * Select exactly one already-authorized window candidate.
 *
 * Process/application ownership must be filtered by the platform adapter before this function is
 * called. This primitive deliberately knows nothing about browser identity, window titles, provider
 * semantics, or transport. It only enforces a bounded, unambiguous window surface.
 */
export declare function selectExactBoundedWindow<TId>(candidates: readonly BoundedWindowGeometry<TId>[], options?: BoundedWindowSelectionOptions): BoundedWindowGeometry<TId>;
export declare function rectContains<TOuterId, TInnerId>(outer: BoundedWindowGeometry<TOuterId>, inner: BoundedWindowGeometry<TInnerId>): boolean;
/** Map a normalized Human pointer coordinate strictly inside the exact bounded window. */
export declare function normalizedPointInWindow<TId>(geometry: BoundedWindowGeometry<TId>, normalizedX: number, normalizedY: number): BoundedWindowPoint;
/** Preserve aspect ratio while capping dimensions and keeping codec-friendly even dimensions. */
export declare function scaledEvenWindowSize(width: number, height: number, maxWidth: number, maxHeight: number): BoundedWindowSize;
//# sourceMappingURL=os-window.d.ts.map