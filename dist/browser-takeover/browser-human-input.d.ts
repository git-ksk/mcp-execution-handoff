/**
 * Transport-neutral Browser Human Input semantics.
 *
 * These helpers define normalized behavior expected from browser clients before input is carried
 * over WSS/WebRTC. They intentionally know nothing about target process/window identity,
 * credentials, transport selection, or OS injection.
 */
export interface BrowserTextReplacementDelta {
    readonly backspaces: number;
    readonly insert: string;
}
export type BrowserImeCompositionPhase = "idle" | "composing" | "settling";
export type BrowserImeCompositionEvent = "composition_start" | "composition_end" | "settled";
/** Keep Safari/iOS IME confirmation events inside one explicit composition lifecycle. */
export declare function browserImeNextCompositionPhase(phase: BrowserImeCompositionPhase, event: BrowserImeCompositionEvent): BrowserImeCompositionPhase;
/**
 * Safari can report the key that confirms an IME candidate after compositionend with
 * `isComposing === false`. Treat the settling phase and legacy IME keyCode 229 as
 * composition-controlled so that confirmation is never forwarded as a remote Enter.
 */
export declare function browserImeKeyboardEventIsCompositionControlled(phase: BrowserImeCompositionPhase, eventIsComposing: boolean, keyCode: number): boolean;
/** Input/beforeinput stays local until the final composition value is ready to diff once. */
export declare function browserImeInputEventIsCompositionControlled(phase: BrowserImeCompositionPhase, eventIsComposing: boolean): boolean;
export declare function browserTextReplacementDelta(previous: string, current: string): BrowserTextReplacementDelta;
/** Convert touch/pointer drag motion to wheel semantics on either axis. */
export declare function browserScrollDelta(pointerDelta: number, scale?: number): number;
/** Vertical compatibility helper for existing Browser Human Input callers. */
export declare function browserScrollDeltaY(pointerDeltaY: number, scale?: number): number;
/** Physical mobile-Safari swipe direction accepted by both WebRTC and WSS Human pages. */
export declare function browserPhysicalSwipeScrollDelta(pointerDelta: number, scale?: number): number;
/** Compatibility name retained for the existing WebRTC client source/tests. */
export declare function browserWebRtcScrollDelta(pointerDelta: number, scale?: number): number;
export type BrowserMobileKeyboardState = "closed" | "explicit";
/** Remote-surface taps never toggle an explicitly opened mobile software keyboard session. */
export declare function browserMobileKeyboardAfterRemoteTap(state: BrowserMobileKeyboardState): BrowserMobileKeyboardState;
/** Emit the pure Browser Human Input helpers shared by WSS and WebRTC browser clients. */
export declare function browserHumanInputClientSource(): string;
//# sourceMappingURL=browser-human-input.d.ts.map