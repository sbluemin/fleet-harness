import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PtyView } from "./pty-view.js";
import { createXterm, getLogicalCursor, projectLogicalCursor } from "./xterm-bridge.js";

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
});

function writeTerminal(terminal: ReturnType<typeof createXterm>, data: string): Promise<void> {
  return new Promise((resolve) => {
    terminal.write(data, resolve);
  });
}
