import { describe, expect, it } from "vitest";

import {
  applyTerminalModifiers,
  controlCharacterFor,
  terminalKeySequence,
  terminalModifierParameter,
  type TerminalKeyModifiers,
} from "../client/shared/terminal-key-sequences.js";

const ESC = String.fromCharCode(0x1b);
const NONE: TerminalKeyModifiers = { ctrl: false, alt: false, shift: false };
const CTRL: TerminalKeyModifiers = { ctrl: true, alt: false, shift: false };
const ALT: TerminalKeyModifiers = { ctrl: false, alt: true, shift: false };

describe("terminalKeySequence", () => {
  it("sends cursor keys as CSI, and as SS3 once the program turns on DECCKM", () => {
    expect(terminalKeySequence("up", NONE, false)).toBe(`${ESC}[A`);
    expect(terminalKeySequence("left", NONE, false)).toBe(`${ESC}[D`);
    expect(terminalKeySequence("up", NONE, true)).toBe(`${ESC}OA`);
    expect(terminalKeySequence("home", NONE, true)).toBe(`${ESC}OH`);
  });

  it("encodes a modified cursor key as CSI with a parameter, never as SS3", () => {
    // SS3 has nowhere to carry a modifier, so even under DECCKM the modified form is CSI.
    expect(terminalKeySequence("left", CTRL, true)).toBe(`${ESC}[1;5D`);
    expect(terminalKeySequence("right", ALT, false)).toBe(`${ESC}[1;3C`);
    expect(terminalKeySequence("end", { ctrl: true, alt: true, shift: false }, false)).toBe(`${ESC}[1;7F`);
  });

  it("numbers the tilde-encoded keys the way xterm does", () => {
    expect(terminalKeySequence("insert")).toBe(`${ESC}[2~`);
    expect(terminalKeySequence("delete")).toBe(`${ESC}[3~`);
    expect(terminalKeySequence("pageUp")).toBe(`${ESC}[5~`);
    expect(terminalKeySequence("pageDown")).toBe(`${ESC}[6~`);
    expect(terminalKeySequence("delete", CTRL)).toBe(`${ESC}[3;5~`);
  });

  it("splits the function keys between SS3 and tilde forms at F5", () => {
    expect(terminalKeySequence("f1")).toBe(`${ESC}OP`);
    expect(terminalKeySequence("f4")).toBe(`${ESC}OS`);
    expect(terminalKeySequence("f5")).toBe(`${ESC}[15~`);
    expect(terminalKeySequence("f12")).toBe(`${ESC}[24~`);
    // 16 is skipped in xterm's numbering; F6 must not drift onto it.
    expect(terminalKeySequence("f6")).toBe(`${ESC}[17~`);
    expect(terminalKeySequence("f1", CTRL)).toBe(`${ESC}[1;5P`);
  });

  it("keeps Shift+Tab as its own sequence rather than a modified tab", () => {
    expect(terminalKeySequence("tab")).toBe(String.fromCharCode(0x09));
    expect(terminalKeySequence("shiftTab")).toBe(`${ESC}[Z`);
    // Ctrl must not fold a multi-byte sequence down to a single control byte.
    expect(terminalKeySequence("shiftTab", CTRL)).toBe(`${ESC}[Z`);
  });

  it("composes Ctrl and Alt onto the keys that are characters", () => {
    expect(terminalKeySequence("escape")).toBe(ESC);
    expect(terminalKeySequence("escape", ALT)).toBe(`${ESC}${ESC}`);
    expect(terminalKeySequence("enter")).toBe(String.fromCharCode(0x0d));
    expect(terminalKeySequence("backspace")).toBe(String.fromCharCode(0x7f));
    expect(terminalKeySequence("backspace", CTRL)).toBe(String.fromCharCode(0x08));
    expect(terminalKeySequence("space", CTRL)).toBe(String.fromCharCode(0x00));
  });
});

describe("controlCharacterFor", () => {
  it("folds letters onto their control bytes in either case", () => {
    expect(controlCharacterFor("c")).toBe(String.fromCharCode(0x03));
    expect(controlCharacterFor("C")).toBe(String.fromCharCode(0x03));
    expect(controlCharacterFor("d")).toBe(String.fromCharCode(0x04));
  });

  it("knows the punctuation that carries a control byte, and refuses the rest", () => {
    expect(controlCharacterFor("[")).toBe(ESC);
    expect(controlCharacterFor("?")).toBe(String.fromCharCode(0x7f));
    expect(controlCharacterFor(" ")).toBe(String.fromCharCode(0x00));
    // A pairing with no control code must not be guessed into some other byte.
    expect(controlCharacterFor("가")).toBeNull();
    expect(controlCharacterFor("ab")).toBeNull();
  });
});

describe("applyTerminalModifiers", () => {
  it("applies a latched Ctrl to a character the soft keyboard produced", () => {
    expect(applyTerminalModifiers("c", CTRL)).toBe(String.fromCharCode(0x03));
    expect(applyTerminalModifiers("b", ALT)).toBe(`${ESC}b`);
    expect(applyTerminalModifiers("x", { ctrl: true, alt: true, shift: false })).toBe(`${ESC}${String.fromCharCode(0x18)}`);
  });

  it("passes text through untouched with no modifier latched", () => {
    expect(applyTerminalModifiers("c", NONE)).toBe("c");
  });

  it("leaves a character Ctrl has no encoding for as itself", () => {
    expect(applyTerminalModifiers("가", CTRL)).toBe("가");
  });

  it("never rewrites multi-character input", () => {
    // A paste or an IME commit arrives as one data event; prefixing or folding it would corrupt it.
    expect(applyTerminalModifiers("hello", CTRL)).toBe("hello");
    expect(applyTerminalModifiers("hello", ALT)).toBe("hello");
  });
});

describe("terminalModifierParameter", () => {
  it("encodes each modifier as its own bit above 1", () => {
    expect(terminalModifierParameter(NONE)).toBe(1);
    expect(terminalModifierParameter({ ctrl: false, alt: false, shift: true })).toBe(2);
    expect(terminalModifierParameter(ALT)).toBe(3);
    expect(terminalModifierParameter(CTRL)).toBe(5);
    expect(terminalModifierParameter({ ctrl: true, alt: true, shift: true })).toBe(8);
  });
});
