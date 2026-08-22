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

export class BoundedWindowSelectionError extends Error {
  constructor(
    public readonly code: "WINDOW_NONE" | "WINDOW_AMBIGUOUS",
    message: string
  ) {
    super(message);
    this.name = "BoundedWindowSelectionError";
  }
}

function finiteGeometry<TId>(geometry: BoundedWindowGeometry<TId>): boolean {
  return [geometry.x, geometry.y, geometry.width, geometry.height].every(Number.isFinite);
}

/**
 * Select exactly one already-authorized window candidate.
 *
 * Process/application ownership must be filtered by the platform adapter before this function is
 * called. This primitive deliberately knows nothing about browser identity, window titles, provider
 * semantics, or transport. It only enforces a bounded, unambiguous window surface.
 */
export function selectExactBoundedWindow<TId>(
  candidates: readonly BoundedWindowGeometry<TId>[],
  options: BoundedWindowSelectionOptions = {}
): BoundedWindowGeometry<TId> {
  const minWidth = options.minWidth ?? 160;
  const minHeight = options.minHeight ?? 120;
  if (!Number.isFinite(minWidth) || !Number.isFinite(minHeight) || minWidth <= 0 || minHeight <= 0) {
    throw new Error("bounded window minimum dimensions are invalid");
  }

  const eligible = candidates.filter((candidate) =>
    finiteGeometry(candidate) && candidate.width >= minWidth && candidate.height >= minHeight
  );
  if (eligible.length === 0) {
    throw new BoundedWindowSelectionError("WINDOW_NONE", "no eligible bounded window is available");
  }
  if (eligible.length !== 1) {
    throw new BoundedWindowSelectionError("WINDOW_AMBIGUOUS", "bounded window selection is ambiguous");
  }
  return eligible[0]!;
}

export function rectContains<TOuterId, TInnerId>(
  outer: BoundedWindowGeometry<TOuterId>,
  inner: BoundedWindowGeometry<TInnerId>
): boolean {
  if (!finiteGeometry(outer) || !finiteGeometry(inner)) return false;
  return inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height;
}

/** Map a normalized Human pointer coordinate into the exact bounded window. */
export function normalizedPointInWindow<TId>(
  geometry: BoundedWindowGeometry<TId>,
  normalizedX: number,
  normalizedY: number
): BoundedWindowPoint {
  if (!finiteGeometry(geometry) || geometry.width <= 0 || geometry.height <= 0) {
    throw new Error("bounded window geometry is invalid");
  }
  if (![normalizedX, normalizedY].every(Number.isFinite) ||
      normalizedX < 0 || normalizedX > 1 || normalizedY < 0 || normalizedY > 1) {
    throw new Error("bounded window normalized coordinate is invalid");
  }
  return {
    x: geometry.x + geometry.width * normalizedX,
    y: geometry.y + geometry.height * normalizedY
  };
}

/** Preserve aspect ratio while capping dimensions and keeping codec-friendly even dimensions. */
export function scaledEvenWindowSize(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number
): BoundedWindowSize {
  if (![width, height, maxWidth, maxHeight].every(Number.isFinite) ||
      width < 2 || height < 2 || maxWidth < 2 || maxHeight < 2) {
    throw new Error("bounded window scale dimensions are invalid");
  }
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  const even = (value: number) => {
    const rounded = Math.max(2, Math.floor(value));
    return rounded % 2 === 0 ? rounded : rounded - 1;
  };
  return { width: even(width * scale), height: even(height * scale) };
}
