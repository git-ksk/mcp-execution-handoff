export declare const MAX_BROWSER_HANDOFF_VIEW_SCALE = 4;
export interface BrowserHandoffViewTransform {
    scale: number;
    panX: number;
    panY: number;
}
export interface BrowserHandoffPinchState {
    startDistance: number;
    startScale: number;
    startPanX: number;
    startPanY: number;
    startMidX: number;
    startMidY: number;
    centerX: number;
    centerY: number;
}
export declare function normalizeBrowserHandoffViewTransform(scale: number, panX: number, panY: number, viewportWidth: number, viewportHeight: number): BrowserHandoffViewTransform;
export declare function browserHandoffPinchTransform(state: BrowserHandoffPinchState, currentDistance: number, currentMidX: number, currentMidY: number, viewportWidth: number, viewportHeight: number): BrowserHandoffViewTransform;
//# sourceMappingURL=mobile-view-transform.d.ts.map