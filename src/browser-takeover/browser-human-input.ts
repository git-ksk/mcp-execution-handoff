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

export function browserTextReplacementDelta(previous: string, current: string): BrowserTextReplacementDelta {
  const before = Array.from(previous);
  const after = Array.from(current);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  return {
    backspaces: before.length - prefix,
    insert: after.slice(prefix).join("")
  };
}

/** A positive client Y drag uses the same sign as the established WebRTC gesture path. */
export function browserScrollDeltaY(pointerDeltaY: number, scale = 3): number {
  if (!Number.isFinite(pointerDeltaY) || !Number.isFinite(scale) || scale <= 0) return 0;
  return Math.max(-2_000, Math.min(2_000, Math.round(pointerDeltaY * scale)));
}

export type BrowserMobileKeyboardState = "closed" | "explicit";

/** Remote-surface taps never toggle an explicitly opened mobile software keyboard session. */
export function browserMobileKeyboardAfterRemoteTap(
  state: BrowserMobileKeyboardState
): BrowserMobileKeyboardState {
  return state;
}
