export function browserTextReplacementDelta(previous, current) {
    const before = Array.from(previous);
    const after = Array.from(current);
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
        prefix += 1;
    return {
        backspaces: before.length - prefix,
        insert: after.slice(prefix).join("")
    };
}
/** A positive client Y drag uses the same sign as the established WebRTC gesture path. */
export function browserScrollDeltaY(pointerDeltaY, scale = 3) {
    if (!Number.isFinite(pointerDeltaY) || !Number.isFinite(scale) || scale <= 0)
        return 0;
    return Math.max(-2_000, Math.min(2_000, Math.round(pointerDeltaY * scale)));
}
/** Remote-surface taps never toggle an explicitly opened mobile software keyboard session. */
export function browserMobileKeyboardAfterRemoteTap(state) {
    return state;
}
//# sourceMappingURL=browser-human-input.js.map