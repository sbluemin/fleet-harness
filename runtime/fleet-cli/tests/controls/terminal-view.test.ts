import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { PtyView, createXterm, getLogicalCursor, getXtermBufferType, projectLogicalCursor, scrollXtermLines } from "../../src/controls/terminal-view.js";

describe("xterm cursor projection", () => {
  it("projects plain ASCII cursor columns", async () => {
    const terminal = createXterm(12, 4);

    await writeTerminal(terminal, "abc");

    assert.deepEqual(projectLogicalCursor(terminal, 12), {
      column: 3,
      row: 0,
      visible: true,
    });
  });

  it("projects CJK wide cells before the cursor", async () => {
    const terminal = createXterm(12, 4);

    await writeTerminal(terminal, "한a");

    assert.deepEqual(projectLogicalCursor(terminal, 12), {
      column: 3,
      row: 0,
      visible: true,
    });
  });

  it("projects combining marks before the cursor", async () => {
    const terminal = createXterm(12, 4);

    await writeTerminal(terminal, "e\u0301a");

    assert.deepEqual(projectLogicalCursor(terminal, 12), {
      column: 2,
      row: 0,
      visible: true,
    });
  });

  it("projects emoji ZWJ clusters before the cursor", async () => {
    const terminal = createXterm(16, 4);

    await writeTerminal(terminal, "👨‍👩‍👧‍👦a");

    assert.deepEqual(projectLogicalCursor(terminal, 16), {
      column: 3,
      row: 0,
      visible: true,
    });
  });

  it("hides cursors outside the visible viewport", async () => {
    const terminal = createXterm(12, 3);

    await writeTerminal(terminal, "one\r\ntwo\r\nthree\r\nfour");
    terminal.scrollToLine(0);

    assert.equal(getLogicalCursor(terminal).visible, false);
    assert.equal(projectLogicalCursor(terminal, 12)?.visible, false);
  });

  it("hides a resized zero-row PtyView anchor", () => {
    const view = new PtyView(12, 4);

    view.resize(12, 0);

    assert.equal(view.getCursorAnchor(12), null);
  });

  it("scrolls normal-buffer viewport lines", async () => {
    const terminal = createXterm(12, 3);

    await writeTerminal(terminal, "one\r\ntwo\r\nthree\r\nfour\r\nfive");
    const before = terminal.buffer.active.viewportY;

    assert.equal(getXtermBufferType(terminal), "normal");
    assert.equal(scrollXtermLines(terminal, -1), true);
    assert.equal(terminal.buffer.active.viewportY, before - 1);
  });

  it("detects alternate buffer and leaves scrollback untouched there", async () => {
    const terminal = createXterm(12, 3);

    await writeTerminal(terminal, "\x1b[?1049hhello");

    assert.equal(getXtermBufferType(terminal), "alternate");
    assert.equal(scrollXtermLines(terminal, 1), false);
  });
});

function writeTerminal(terminal: ReturnType<typeof createXterm>, data: string): Promise<void> {
  return new Promise((resolve) => {
    terminal.write(data, resolve);
  });
}
