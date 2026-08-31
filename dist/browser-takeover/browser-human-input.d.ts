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
/** Convert touch/pointer drag motion to wheel semantics on either axis. */
export declare function browserScrollDelta(pointerDelta: number, scale?: number): number;
/** Vertical compatibility helper for existing Browser Human Input callers. */
export declare function browserScrollDeltaY(pointerDeltaY: number, scale?: number): number;
export type BrowserMobileKeyboardState = "closed" | "explicit";
/** Remote-surface taps never toggle an explicitly opened mobile software keyboard session. */
export declare function browserMobileKeyboardAfterRemoteTap(state: BrowserMobileKeyboardState): BrowserMobileKeyboardState;
/** Emit the pure Browser Human Input helpers shared by WSS and WebRTC browser clients. */
export declare function browserHumanInputClientSource(): string;
//# sourceMappingURL=browser-human-input.d.ts.map