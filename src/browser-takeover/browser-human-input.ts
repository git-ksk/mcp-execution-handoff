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

/** Convert touch/pointer drag motion to wheel semantics on either axis. */
export function browserScrollDelta(pointerDelta: number, scale = 3): number {
  if (!Number.isFinite(pointerDelta) || !Number.isFinite(scale) || scale <= 0) return 0;
  return Math.max(-2_000, Math.min(2_000, Math.round(-pointerDelta * scale)));
}

/** Vertical compatibility helper for existing Browser Human Input callers. */
export function browserScrollDeltaY(pointerDeltaY: number, scale = 3): number {
  return browserScrollDelta(pointerDeltaY, scale);
}

/** Physical mobile-Safari swipe direction accepted by both WebRTC and WSS Human pages. */
export function browserPhysicalSwipeScrollDelta(pointerDelta: number, scale = 3): number {
  return -browserScrollDelta(pointerDelta, scale);
}

/** Compatibility name retained for the existing WebRTC client source/tests. */
export function browserWebRtcScrollDelta(pointerDelta: number, scale = 3): number {
  return browserPhysicalSwipeScrollDelta(pointerDelta, scale);
}

export type BrowserMobileKeyboardState = "closed" | "explicit";

/** Remote-surface taps never toggle an explicitly opened mobile software keyboard session. */
export function browserMobileKeyboardAfterRemoteTap(
  state: BrowserMobileKeyboardState
): BrowserMobileKeyboardState {
  return state;
}

/** Emit the pure Browser Human Input helpers shared by WSS and WebRTC browser clients. */
export function browserHumanInputClientSource(): string {
  return [
    `const browserTextReplacementDelta=${browserTextReplacementDelta.toString()};`,
    `const browserScrollDelta=${browserScrollDelta.toString()};`,
    `const browserScrollDeltaY=${browserScrollDeltaY.toString()};`,
    `const browserPhysicalSwipeScrollDelta=${browserPhysicalSwipeScrollDelta.toString()};`,
    `const browserWebRtcScrollDelta=${browserWebRtcScrollDelta.toString()};`
  ].join("");
}
