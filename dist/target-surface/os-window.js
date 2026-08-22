export class BoundedWindowSelectionError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "BoundedWindowSelectionError";
    }
}
function finiteGeometry(geometry) {
    return [geometry.x, geometry.y, geometry.width, geometry.height].every(Number.isFinite);
}
/**
 * Select exactly one already-authorized window candidate.
 *
 * Process/application ownership must be filtered by the platform adapter before this function is
 * called. This primitive deliberately knows nothing about browser identity, window titles, provider
 * semantics, or transport. It only enforces a bounded, unambiguous window surface.
 */
export function selectExactBoundedWindow(candidates, options = {}) {
    const minWidth = options.minWidth ?? 160;
    const minHeight = options.minHeight ?? 120;
    if (!Number.isFinite(minWidth) || !Number.isFinite(minHeight) || minWidth <= 0 || minHeight <= 0) {
        throw new Error("bounded window minimum dimensions are invalid");
    }
    const eligible = candidates.filter((candidate) => finiteGeometry(candidate) && candidate.width >= minWidth && candidate.height >= minHeight);
    if (eligible.length === 0) {
        throw new BoundedWindowSelectionError("WINDOW_NONE", "no eligible bounded window is available");
    }
    if (eligible.length !== 1) {
        throw new BoundedWindowSelectionError("WINDOW_AMBIGUOUS", "bounded window selection is ambiguous");
    }
    return eligible[0];
}
export function rectContains(outer, inner) {
    if (!finiteGeometry(outer) || !finiteGeometry(inner))
        return false;
    return inner.x >= outer.x &&
        inner.y >= outer.y &&
        inner.x + inner.width <= outer.x + outer.width &&
        inner.y + inner.height <= outer.y + outer.height;
}
/** Map a normalized Human pointer coordinate strictly inside the exact bounded window. */
export function normalizedPointInWindow(geometry, normalizedX, normalizedY) {
    if (!finiteGeometry(geometry) || geometry.width <= 0 || geometry.height <= 0) {
        throw new Error("bounded window geometry is invalid");
    }
    if (![normalizedX, normalizedY].every(Number.isFinite) ||
        normalizedX < 0 || normalizedX > 1 || normalizedY < 0 || normalizedY > 1) {
        throw new Error("bounded window normalized coordinate is invalid");
    }
    const insideOffset = (extent, normalized) => {
        const maxInside = Math.max(0, extent - Math.min(1, extent));
        return Math.min(extent * normalized, maxInside);
    };
    return {
        x: geometry.x + insideOffset(geometry.width, normalizedX),
        y: geometry.y + insideOffset(geometry.height, normalizedY)
    };
}
/** Preserve aspect ratio while capping dimensions and keeping codec-friendly even dimensions. */
export function scaledEvenWindowSize(width, height, maxWidth, maxHeight) {
    if (![width, height, maxWidth, maxHeight].every(Number.isFinite) ||
        width < 2 || height < 2 || maxWidth < 2 || maxHeight < 2) {
        throw new Error("bounded window scale dimensions are invalid");
    }
    const scale = Math.min(1, maxWidth / width, maxHeight / height);
    const even = (value) => {
        const rounded = Math.max(2, Math.floor(value));
        return rounded % 2 === 0 ? rounded : rounded - 1;
    };
    return { width: even(width * scale), height: even(height * scale) };
}
//# sourceMappingURL=os-window.js.map