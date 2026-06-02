import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { ANSI_RESET, paint, stripAnsi } from "../../src/styles/ansi.js";

describe("stripAnsi", () => {
  it("removes terminal control sequences beyond SGR", () => {
    assert.equal(stripAnsi("a\x1b]52;c;QUFB\x07b"), "ab");
    assert.equal(stripAnsi("a\x1bP1;2|payload\x1b\\b"), "ab");
    assert.equal(stripAnsi("a\x1b[2Jb"), "ab");
  });

  it("removes C1 terminal control sequence forms", () => {
    assert.equal(stripAnsi("a\x9d52;c;QUFB\x9cb"), "ab");
    assert.equal(stripAnsi("a\x901;2|payload\x9cb"), "ab");
    assert.equal(stripAnsi("a\x9b2Jb"), "ab");
  });

  it("preserves paint color wrapping semantics", () => {
    assert.equal(paint("\x1b[31m", "fleet", true), `\x1b[31mfleet${ANSI_RESET}`);
    assert.equal(paint("\x1b[31m", "fleet", false), "fleet");
    assert.equal(stripAnsi(paint("\x1b[31m", "fleet", true)), "fleet");
  });
});
