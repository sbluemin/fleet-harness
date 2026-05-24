import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { createCsiUInputNormalizer, createKeyboardProtocol, encodeTerminalInput, normalizeCsiUInput } from "../../src/controls/pty.js";

describe("keyboard protocol", () => {
  it("transforms Shift+Enter CSI u input until the child requests enhanced input", () => {
    const protocol = createKeyboardProtocol();

    assert.deepEqual(protocol.getState(), {
      outerEnabled: true,
      childRequested: false,
      effectiveMode: "transform",
    });
    assert.equal(encodeTerminalInput("\x1b[13;2u", protocol), "\n");

    protocol.detectChildRequest("\x1b[>1u");

    assert.deepEqual(protocol.getState(), {
      outerEnabled: true,
      childRequested: true,
      effectiveMode: "passthrough",
    });
    assert.equal(encodeTerminalInput("\x1b[13;2u", protocol), "\x1b[13;2u");
  });

  it("detects modifyOtherKeys enhanced requests", () => {
    const protocol = createKeyboardProtocol();

    protocol.detectChildRequest("before\x1b[>4;2mafter");

    assert.equal(protocol.getState().childRequested, true);
  });

  it("keeps key encoding backward compatible without a protocol", () => {
    assert.equal(encodeTerminalInput("\x1b[13;2u"), "\x1b[13;2u");
  });
});

describe("normalizeCsiUInput", () => {
  it("normalizes supplied CSI-u mappings only", () => {
    const map = new Map([
      ["\x1b[99;5u", "\x03"],
      ["\x1b[116;5u", "\x14"],
    ]);

    assert.equal(normalizeCsiUInput("\x1b[99;5u", map), "\x03");
    assert.equal(normalizeCsiUInput("\x1b[116;5u", map), "\x14");
    assert.equal(normalizeCsiUInput("\x1b[113;5u", map), "\x1b[113;5u");
  });

  it("passes through all other CSI u sequences untouched", () => {
    const map = new Map([["\x1b[99;5u", "\x03"]]);

    assert.equal(normalizeCsiUInput("\x1b[13;2u", map), "\x1b[13;2u");
    assert.equal(normalizeCsiUInput("\x1b[13u", map), "\x1b[13u");
    assert.equal(normalizeCsiUInput("\x1b[9u", map), "\x1b[9u");
    assert.equal(normalizeCsiUInput("\x1b[100;5u", map), "\x1b[100;5u");
    assert.equal(normalizeCsiUInput("\x1b[13;6u", map), "\x1b[13;6u");
  });

  it("handles mixed input with CSI u and plain text", () => {
    const normalizer = createCsiUInputNormalizer({ csiUMap: new Map([["\x1b[116;5u", "\x14"]]) });

    assert.equal(normalizer.normalize("hello\x1b[116;5uworld"), "hello\x14world");
  });
});
