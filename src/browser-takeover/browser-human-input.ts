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

export interface BrowserTextReplacementMutation extends BrowserTextReplacementDelta {
  /** Logical hidden-textarea mirror after the remote suffix replacement is applied. */
  readonly next: string;
}

export type BrowserImeCompositionPhase = "idle" | "composing" | "settling";
export type BrowserImeCompositionEvent = "composition_start" | "composition_end" | "settled";

/** Keep Safari/iOS IME confirmation events inside one explicit composition lifecycle. */
export function browserImeNextCompositionPhase(
  phase: BrowserImeCompositionPhase,
  event: BrowserImeCompositionEvent
): BrowserImeCompositionPhase {
  if (event === "composition_start") return "composing";
  if (event === "composition_end") return "settling";
  return phase === "settling" ? "idle" : phase;
}

/**
 * Safari can report the key that confirms an IME candidate after compositionend with
 * `isComposing === false`. Treat the settling phase and legacy IME keyCode 229 as
 * composition-controlled so that confirmation is never forwarded as a remote Enter.
 */
export function browserImeKeyboardEventIsCompositionControlled(
  phase: BrowserImeCompositionPhase,
  eventIsComposing: boolean,
  keyCode: number
): boolean {
  return phase !== "idle" || eventIsComposing || keyCode === 229;
}

/** Input/beforeinput stays local until the finalized composition can be committed once. */
export function browserImeInputEventIsCompositionControlled(
  phase: BrowserImeCompositionPhase,
  eventIsComposing: boolean
): boolean {
  return phase !== "idle" || eventIsComposing;
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

/**
 * Normalize an ordinary DOM text mutation to the suffix-only remote editing contract.
 *
 * Hidden mobile textareas occasionally expose a third-party keyboard `insertText` payload before
 * their DOM value contains the payload's final code point(s). When the DOM insertion is a strict
 * prefix of the bounded InputEvent.data payload, extend only that insertion suffix and normalize
 * the hidden mirror to the resulting value. All other replacements stay DOM-authoritative.
 * Composition commits deliberately bypass this correction and retain #232 semantics.
 */
export function browserTextReplacementMutation(
  previous: string,
  current: string,
  inputType: string,
  inputData: string | null | undefined
): BrowserTextReplacementMutation {
  const delta = browserTextReplacementDelta(previous, current);
  let insert = delta.insert;
  let next = current;
  if (
    inputType === "insertText"
    && typeof inputData === "string"
    && inputData.length > 0
    && insert.length > 0
    && insert !== inputData
    && inputData.startsWith(insert)
  ) {
    const before = Array.from(previous);
    const retained = before.slice(0, Math.max(0, before.length - delta.backspaces)).join("");
    const candidate = retained + inputData;
    if (candidate.startsWith(current) && Array.from(candidate).length > Array.from(current).length) {
      insert = inputData;
      next = candidate;
    }
  }
  return { backspaces: delta.backspaces, insert, next };
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
    `const browserImeNextCompositionPhase=${browserImeNextCompositionPhase.toString()};`,
    `const browserImeKeyboardEventIsCompositionControlled=${browserImeKeyboardEventIsCompositionControlled.toString()};`,
    `const browserImeInputEventIsCompositionControlled=${browserImeInputEventIsCompositionControlled.toString()};`,
    `const browserTextReplacementDelta=${browserTextReplacementDelta.toString()};`,
    `const browserTextReplacementMutation=${browserTextReplacementMutation.toString()};`,
    `const browserScrollDelta=${browserScrollDelta.toString()};`,
    `const browserScrollDeltaY=${browserScrollDeltaY.toString()};`,
    `const browserPhysicalSwipeScrollDelta=${browserPhysicalSwipeScrollDelta.toString()};`,
    `const browserWebRtcScrollDelta=${browserWebRtcScrollDelta.toString()};`
  ].join("");
}
