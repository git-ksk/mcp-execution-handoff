export const MAX_BROWSER_HANDOFF_VIEW_SCALE = 4;

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

export function normalizeBrowserHandoffViewTransform(
  scale: number,
  panX: number,
  panY: number,
  viewportWidth: number,
  viewportHeight: number
): BrowserHandoffViewTransform {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0 || !Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return { scale: 1, panX: 0, panY: 0 };
  }
  const nextScale = clamp(Number.isFinite(scale) ? scale : 1, 1, MAX_BROWSER_HANDOFF_VIEW_SCALE);
  const maxPanX = Math.max(0, (nextScale - 1) * viewportWidth / 2);
  const maxPanY = Math.max(0, (nextScale - 1) * viewportHeight / 2);
  return {
    scale: nextScale,
    panX: clamp(Number.isFinite(panX) ? panX : 0, -maxPanX, maxPanX),
    panY: clamp(Number.isFinite(panY) ? panY : 0, -maxPanY, maxPanY)
  };
}

export function browserHandoffPinchTransform(
  state: BrowserHandoffPinchState,
  currentDistance: number,
  currentMidX: number,
  currentMidY: number,
  viewportWidth: number,
  viewportHeight: number
): BrowserHandoffViewTransform {
  const safeStartDistance = Math.max(1, Number.isFinite(state.startDistance) ? state.startDistance : 1);
  const ratio = clamp((Number.isFinite(currentDistance) ? currentDistance : safeStartDistance) / safeStartDistance, 0.25, 4);
  const nextScale = clamp(state.startScale * ratio, 1, MAX_BROWSER_HANDOFF_VIEW_SCALE);
  const scaleRatio = nextScale / Math.max(1, state.startScale);
  const panX = currentMidX - state.centerX - scaleRatio * (state.startMidX - state.centerX - state.startPanX);
  const panY = currentMidY - state.centerY - scaleRatio * (state.startMidY - state.centerY - state.startPanY);
  return normalizeBrowserHandoffViewTransform(nextScale, panX, panY, viewportWidth, viewportHeight);
}

function clamp(value: number, min: number, max: number): number {
  const result = Math.max(min, Math.min(max, value));
  return Object.is(result, -0) ? 0 : result;
}
