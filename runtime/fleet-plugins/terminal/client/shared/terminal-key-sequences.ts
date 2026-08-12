/**
 * The bytes a terminal expects for the keys a phone keyboard does not have.
 *
 * A soft keyboard sends characters, not keys: there is no Escape, no arrow, no Ctrl, so a TUI that
 * reads those is unreachable from a phone. The key bar sends them directly, which means this module
 * has to produce what xterm would have produced from a real key press — including the modifier
 * encodings, since Ctrl+C on a runaway process and Alt+B in a line editor are the reason the bar
 * exists at all.
 *
 * Sequences follow xterm's own conventions: DECCKM decides whether a cursor key is CSI or SS3, and
 * a modified key always takes the CSI form with an encoded parameter, because SS3 has nowhere to
 * carry one.
 *
 * Control bytes are built from their code points rather than written as literals — a literal one in
 * the source makes git treat the file as binary, and a reviewer cannot see which byte it is.
 */

const ESC = String.fromCharCode(0x1b);
const TAB = String.fromCharCode(0x09);
const CR = String.fromCharCode(0x0d);
const BS = String.fromCharCode(0x08);
const DEL = String.fromCharCode(0x7f);
const NUL = String.fromCharCode(0x00);
const CSI = `${ESC}[`;
const SS3 = `${ESC}O`;

export interface TerminalKeyModifiers {
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

export const NO_TERMINAL_MODIFIERS: TerminalKeyModifiers = { ctrl: false, alt: false, shift: false };

export type TerminalKeyId =
  | "escape"
  | "tab"
  | "shiftTab"
  | "enter"
  | "backspace"
  | "space"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageUp"
  | "pageDown"
  | "insert"
  | "delete"
  | "f1" | "f2" | "f3" | "f4" | "f5" | "f6"
  | "f7" | "f8" | "f9" | "f10" | "f11" | "f12";

/** Cursor and editing keys whose CSI form ends in a letter. */
const CSI_FINAL: Partial<Record<TerminalKeyId, string>> = {
  up: "A",
  down: "B",
  right: "C",
  left: "D",
  home: "H",
  end: "F",
};

/** Keys encoded as CSI <code> ~, where the code identifies the key. */
const TILDE_CODE: Partial<Record<TerminalKeyId, number>> = {
  insert: 2,
  delete: 3,
  pageUp: 5,
  pageDown: 6,
  f5: 15,
  f6: 17,
  f7: 18,
  f8: 19,
  f9: 20,
  f10: 21,
  f11: 23,
  f12: 24,
};

/** F1–F4 are SS3 when unmodified and CSI 1;<mod> <final> when not. */
const SS3_FINAL: Partial<Record<TerminalKeyId, string>> = {
  f1: "P",
  f2: "Q",
  f3: "R",
  f4: "S",
};

/**
 * xterm's modifier parameter: 1 plus a bit per held modifier. A value of 1 means "no modifier",
 * which is also the signal to use the shorter unmodified form of the sequence.
 */
export function terminalModifierParameter(modifiers: TerminalKeyModifiers): number {
  return 1 + (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
}

/**
 * The control byte a character carries under Ctrl, or null when the pairing has no control code.
 * Returning null rather than a guess matters: a Ctrl the terminal has no encoding for must reach
 * the session as the plain character, not as a byte that means something else.
 */
export function controlCharacterFor(character: string): string | null {
  if (Array.from(character).length !== 1) return null;
  const code = character.codePointAt(0);
  if (code === undefined) return null;
  // Both cases fold onto the same control byte, the way a physical Ctrl+C and Ctrl+Shift+C do.
  if (code >= 0x61 && code <= 0x7a) return String.fromCharCode(code - 0x60);
  if (code >= 0x41 && code <= 0x5a) return String.fromCharCode(code - 0x40);
  switch (character) {
    case "@":
    case " ":
      return NUL;
    case "[": return ESC;
    case "\\": return String.fromCharCode(0x1c);
    case "]": return String.fromCharCode(0x1d);
    case "^": return String.fromCharCode(0x1e);
    case "_": return String.fromCharCode(0x1f);
    case "?": return DEL;
    default: return null;
  }
}

/**
 * Applies bar-held modifiers to text the soft keyboard produced. Only a single character is
 * transformed: a paste, an IME commit, or an emoji is several code points, and prefixing that with
 * Escape or folding it to one control byte would corrupt it — those pass through untouched.
 */
export function applyTerminalModifiers(data: string, modifiers: TerminalKeyModifiers): string {
  if (!modifiers.ctrl && !modifiers.alt) return data;
  if (Array.from(data).length !== 1) return data;
  const controlled = modifiers.ctrl ? controlCharacterFor(data) ?? data : data;
  return modifiers.alt ? `${ESC}${controlled}` : controlled;
}

/**
 * The bytes for one bar key. `applicationCursor` is DECCKM: full-screen programs turn it on and
 * then read SS3 rather than CSI for the cursor keys, so a bar that always sent CSI would move the
 * cursor in a shell and do nothing in an editor.
 */
export function terminalKeySequence(
  id: TerminalKeyId,
  modifiers: TerminalKeyModifiers = NO_TERMINAL_MODIFIERS,
  applicationCursor = false,
): string {
  if (id === "shiftTab") return terminalKeySequence("tab", { ...modifiers, shift: true }, applicationCursor);

  const parameter = terminalModifierParameter(modifiers);
  const modified = parameter !== 1;

  const csiFinal = CSI_FINAL[id];
  if (csiFinal !== undefined) {
    if (modified) return `${CSI}1;${parameter}${csiFinal}`;
    return applicationCursor ? `${SS3}${csiFinal}` : `${CSI}${csiFinal}`;
  }

  const tildeCode = TILDE_CODE[id];
  if (tildeCode !== undefined) {
    return modified ? `${CSI}${tildeCode};${parameter}~` : `${CSI}${tildeCode}~`;
  }

  const ss3Final = SS3_FINAL[id];
  if (ss3Final !== undefined) {
    return modified ? `${CSI}1;${parameter}${ss3Final}` : `${SS3}${ss3Final}`;
  }

  // The remaining keys already exist as characters, so Ctrl and Alt compose onto them the same way
  // they compose onto anything typed — Alt prefixes an Escape, Ctrl folds to a control byte.
  const base = plainKeyCharacter(id, modifiers);
  if (base === null) return "";
  // Shift+Tab is already a CSI sequence, not a character, so Ctrl must not fold it to a byte.
  const foldable = base.length === 1;
  const controlled = modifiers.ctrl && foldable ? controlCharacterFor(base) ?? base : base;
  return modifiers.alt ? `${ESC}${controlled}` : controlled;
}

function plainKeyCharacter(id: TerminalKeyId, modifiers: TerminalKeyModifiers): string | null {
  switch (id) {
    case "escape": return ESC;
    // CSI Z is Shift+Tab's own sequence; it displaces the plain tab character rather than modifying it.
    case "tab": return modifiers.shift ? `${CSI}Z` : TAB;
    case "enter": return CR;
    // Terminals read DEL as the erasing backspace; Ctrl+Backspace is the older BS byte.
    case "backspace": return modifiers.ctrl ? BS : DEL;
    case "space": return " ";
    default: return null;
  }
}
