import { describe, expect, it } from "vitest";

import { ANSI_RESET, paint, stripAnsi } from "../src/help-style.js";

describe("help-style stripAnsi", () => {
  it("removes terminal control sequences beyond SGR", () => {
    expect(stripAnsi("a\x1b]52;c;QUFB\x07b")).toBe("ab");
    expect(stripAnsi("a\x1bP1;2|payload\x1b\\b")).toBe("ab");
    expect(stripAnsi("a\x1b[2Jb")).toBe("ab");
  });

  it("removes C1 terminal control sequence forms", () => {
    expect(stripAnsi("a\x9d52;c;QUFB\x9cb")).toBe("ab");
    expect(stripAnsi("a\x901;2|payload\x9cb")).toBe("ab");
    expect(stripAnsi("a\x9b2Jb")).toBe("ab");
  });

  it("preserves paint color wrapping semantics", () => {
    expect(paint("\x1b[31m", "fleet", true)).toBe(`\x1b[31mfleet${ANSI_RESET}`);
    expect(paint("\x1b[31m", "fleet", false)).toBe("fleet");
    expect(stripAnsi(paint("\x1b[31m", "fleet", true))).toBe("fleet");
  });
});
