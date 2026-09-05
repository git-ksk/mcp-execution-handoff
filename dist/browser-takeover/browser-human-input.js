/** Keep Safari/iOS IME confirmation events inside one explicit composition lifecycle. */
export function browserImeNextCompositionPhase(phase, event) {
    if (event === "composition_start")
        return "composing";
    if (event === "composition_end")
        return "settling";
    return phase === "settling" ? "idle" : phase;
}
/**
 * Safari can report the key that confirms an IME candidate after compositionend with
 * `isComposing === false`. Treat the settling phase and legacy IME keyCode 229 as
 * composition-controlled so that confirmation is never forwarded as a remote Enter.
 */
export function browserImeKeyboardEventIsCompositionControlled(phase, eventIsComposing, keyCode) {
    return phase !== "idle" || eventIsComposing || keyCode === 229;
}
/** Input/beforeinput stays local until the final composition value is ready to diff once. */
export function browserImeInputEventIsCompositionControlled(phase, eventIsComposing) {
    return phase !== "idle" || eventIsComposing;
}
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
/** Convert touch/pointer drag motion to wheel semantics on either axis. */
export function browserScrollDelta(pointerDelta, scale = 3) {
    if (!Number.isFinite(pointerDelta) || !Number.isFinite(scale) || scale <= 0)
        return 0;
    return Math.max(-2_000, Math.min(2_000, Math.round(-pointerDelta * scale)));
}
/** Vertical compatibility helper for existing Browser Human Input callers. */
export function browserScrollDeltaY(pointerDeltaY, scale = 3) {
    return browserScrollDelta(pointerDeltaY, scale);
}
/** Physical mobile-Safari swipe direction accepted by both WebRTC and WSS Human pages. */
export function browserPhysicalSwipeScrollDelta(pointerDelta, scale = 3) {
    return -browserScrollDelta(pointerDelta, scale);
}
/** Compatibility name retained for the existing WebRTC client source/tests. */
export function browserWebRtcScrollDelta(pointerDelta, scale = 3) {
    return browserPhysicalSwipeScrollDelta(pointerDelta, scale);
}
/** Remote-surface taps never toggle an explicitly opened mobile software keyboard session. */
export function browserMobileKeyboardAfterRemoteTap(state) {
    return state;
}
/** Emit the pure Browser Human Input helpers shared by WSS and WebRTC browser clients. */
export function browserHumanInputClientSource() {
    return [
        `const browserImeNextCompositionPhase=${browserImeNextCompositionPhase.toString()};`,
        `const browserImeKeyboardEventIsCompositionControlled=${browserImeKeyboardEventIsCompositionControlled.toString()};`,
        `const browserImeInputEventIsCompositionControlled=${browserImeInputEventIsCompositionControlled.toString()};`,
        `const browserTextReplacementDelta=${browserTextReplacementDelta.toString()};`,
        `const browserScrollDelta=${browserScrollDelta.toString()};`,
        `const browserScrollDeltaY=${browserScrollDeltaY.toString()};`,
        `const browserPhysicalSwipeScrollDelta=${browserPhysicalSwipeScrollDelta.toString()};`,
        `const browserWebRtcScrollDelta=${browserWebRtcScrollDelta.toString()};`
    ].join("");
}
//# sourceMappingURL=browser-human-input.js.map