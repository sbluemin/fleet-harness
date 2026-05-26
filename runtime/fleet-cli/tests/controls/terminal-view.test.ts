import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  PtyView,
  createXterm,
  getLogicalCursor,
  getXtermBufferType,
  projectLogicalCursor,
  renderXtermViewport,
  scrollXtermLines,
} from "../../src/controls/terminal-view.js";

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

  it("trims trailing default spaces when the cursor reaches the right edge", async () => {
    const terminal = createXterm(6, 4);

    await writeTerminal(terminal, "abc   ");

    assert.equal(getLogicalCursor(terminal).x, 6);
    assert.deepEqual(projectLogicalCursor(terminal, 6), {
      column: 3,
      row: 0,
      visible: true,
    });
  });

  it("trims trailing empty cells when the cursor parks at the last column", async () => {
    const terminal = createXterm(6, 4);

    // Write "abc" then explicitly park cursor at the rightmost column (1-based col 6).
    // Cells [3..5] remain unwritten (code 0, chars "") — this matches Claude Code / Ink behavior
    // on Windows ConPTY where the cursor is positioned at the last column with empty trailing cells.
    await writeTerminal(terminal, "abc\x1b[1;6H");

    assert.equal(getLogicalCursor(terminal).x, 5);
    assert.deepEqual(projectLogicalCursor(terminal, 6), {
      column: 3,
      row: 0,
      visible: true,
    });
  });

  it("projects right-edge all-default-space lines to column zero", async () => {
    const terminal = createXterm(6, 4);

    await writeTerminal(terminal, "      ");

    assert.equal(getLogicalCursor(terminal).x, 6);
    assert.deepEqual(projectLogicalCursor(terminal, 6), {
      column: 0,
      row: 0,
      visible: true,
    });
  });

  it("preserves styled trailing spaces at the right edge", async () => {
    const terminal = createXterm(6, 4);

    await writeTerminal(terminal, "abc\x1b[41m   \x1b[0m");

    assert.equal(getLogicalCursor(terminal).x, 6);
    assert.deepEqual(projectLogicalCursor(terminal, 6), {
      column: 5,
      row: 0,
      visible: true,
    });
  });

  it("preserves in-line trailing spaces before the right edge", async () => {
    const terminal = createXterm(6, 4);

    await writeTerminal(terminal, "abc ");

    assert.equal(getLogicalCursor(terminal).x, 4);
    assert.deepEqual(projectLogicalCursor(terminal, 6), {
      column: 4,
      row: 0,
      visible: true,
    });
  });

  it("trims right-edge default spaces after wide cells", async () => {
    const terminal = createXterm(6, 4);

    await writeTerminal(terminal, "한    ");

    assert.equal(getLogicalCursor(terminal).x, 6);
    assert.deepEqual(projectLogicalCursor(terminal, 6), {
      column: 2,
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

describe("xterm viewport rendering", () => {
  it("trims trailing default-style spaces from rendered lines", async () => {
    const terminal = createXterm(6, 2);

    await writeTerminal(terminal, "abc   ");

    assert.equal(stripAnsi(renderXtermViewport(terminal)[0]), "abc");
  });

  it("renders all-default-space lines as empty strings", async () => {
    const terminal = createXterm(6, 2);

    await writeTerminal(terminal, "      ");

    assert.equal(renderXtermViewport(terminal)[0], "");
  });

  it("preserves styled trailing spaces in rendered lines", async () => {
    const terminal = createXterm(6, 2);

    await writeTerminal(terminal, "abc\x1b[41m   \x1b[0m");

    const rendered = renderXtermViewport(terminal)[0];

    assert.equal(stripAnsi(rendered), "abc   ");
    assert.match(rendered, /\x1b\[[0-9;]*48;5;1m   /);
  });

  it("trims default-style spaces before the cursor reaches the right edge without moving the cursor anchor", async () => {
    const terminal = createXterm(6, 2);

    await writeTerminal(terminal, "abc ");

    assert.equal(stripAnsi(renderXtermViewport(terminal)[0]), "abc");
    assert.deepEqual(projectLogicalCursor(terminal, 6), {
      column: 4,
      row: 0,
      visible: true,
    });
  });

  it("trims wide-cell continuations and trailing default-style spaces from rendered lines", async () => {
    const terminal = createXterm(6, 2);

    await writeTerminal(terminal, "한    ");

    assert.equal(stripAnsi(renderXtermViewport(terminal)[0]), "한");
  });
});

function writeTerminal(terminal: ReturnType<typeof createXterm>, data: string): Promise<void> {
  return new Promise((resolve) => {
    terminal.write(data, resolve);
  });
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}
