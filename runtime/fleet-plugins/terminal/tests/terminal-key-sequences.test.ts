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
});

describe("controlCharacterFor", () => {
  it("folds letters onto their control bytes in either case", () => {
    expect(controlCharacterFor("c")).toBe(String.fromCharCode(0x03));
    expect(controlCharacterFor("C")).toBe(String.fromCharCode(0x03));
    expect(controlCharacterFor("d")).toBe(String.fromCharCode(0x04));
  });
});

describe("applyTerminalModifiers", () => {

  it("never rewrites multi-character input", () => {
    // A paste or an IME commit arrives as one data event; prefixing or folding it would corrupt it.
    expect(applyTerminalModifiers("hello", CTRL)).toBe("hello");
    expect(applyTerminalModifiers("hello", ALT)).toBe("hello");
  });
});
