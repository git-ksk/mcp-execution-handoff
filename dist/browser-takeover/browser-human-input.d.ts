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
export declare function browserTextReplacementDelta(previous: string, current: string): BrowserTextReplacementDelta;
/** A positive client Y drag uses the same sign as the established WebRTC gesture path. */
export declare function browserScrollDeltaY(pointerDeltaY: number, scale?: number): number;
export type BrowserMobileKeyboardState = "closed" | "explicit";
/** Remote-surface taps never toggle an explicitly opened mobile software keyboard session. */
export declare function browserMobileKeyboardAfterRemoteTap(state: BrowserMobileKeyboardState): BrowserMobileKeyboardState;
//# sourceMappingURL=browser-human-input.d.ts.map