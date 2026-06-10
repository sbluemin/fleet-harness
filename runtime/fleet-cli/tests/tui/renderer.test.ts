import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import { LocalTui } from "../../src/tui/renderer.js";
import type { Component } from "../../src/tui/types.js";

const ORIGINAL_COLUMNS = process.stdout.columns;
const ORIGINAL_KILL = process.kill;
const ORIGINAL_ROWS = process.stdout.rows;
const ORIGINAL_WRITE = process.stdout.write;

let writes: string[] = [];

describe("LocalTui", () => {
  beforeEach(() => {
    writes = [];
    setTerminalSize(12, 4);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.kill = ORIGINAL_KILL;
    process.stdout.write = ORIGINAL_WRITE;
    setTerminalSize(ORIGINAL_COLUMNS, ORIGINAL_ROWS);
  });

  it("enters and exits alt-screen by default exactly once", () => {
    const tui = new LocalTui();

    tui.start();
    tui.start();
    tui.stop();
    tui.stop();

    assert.equal(countWrites("\x1b[?1049h"), 1);
    assert.equal(countWrites("\x1b[?1049l"), 1);
  });

  it("enables and disables SGR mouse reporting exactly once per lifecycle", () => {
    const tui = new LocalTui();

    tui.start();
    tui.start();
    tui.stop();
    tui.stop();

    assert.equal(countWrites("\x1b[?1000h"), 1);
    assert.equal(countWrites("\x1b[?1002h"), 1);
    assert.equal(countWrites("\x1b[?1006h"), 1);
    assert.equal(countWrites("\x1b[?1006l"), 1);
    assert.equal(countWrites("\x1b[?1002l"), 1);
    assert.equal(countWrites("\x1b[?1000l"), 1);
  });

  it("supports useAltScreen opt-out", () => {
    const tui = new LocalTui({ useAltScreen: false });

    tui.start();
    tui.stop();

    assert.equal(writes.join("").includes("\x1b[?1049h"), false);
    assert.equal(writes.join("").includes("\x1b[?1049l"), false);
  });

  it("coalesces render bursts inside the scheduler window", async () => {
    const component = mutableComponent(["alpha"]);
    const tui = new LocalTui({ renderIntervalMs: 5 });

    tui.setChildren([component]);
    tui.start();
    component.lines = ["beta"];
    tui.requestRender();
    tui.requestRender();
    await delay(12);
    tui.stop();

    const renderWrites = writes.filter((write) => write.includes("\x1b[1;1H"));
    assert.equal(renderWrites.length, 1);
    assert.match(renderWrites[0] ?? "", /beta/);
  });

  it("skips identical row diffs while still syncing the cursor", () => {
    const component = mutableComponent(["alpha", "bravo"]);
    const tui = new LocalTui({ renderIntervalMs: 1000 });

    tui.setChildren([component]);
    tui.start();
    flush(tui, true);
    writes = [];

    flush(tui, false);
    assert.equal(writes.join(""), "\x1b[?25l");

    component.lines = ["alpha", "charlie"];
    flush(tui, false);

    const output = writes.join("");
    assert.equal(output.includes("\x1b[1;1H"), false);
    assert.equal(output.includes("\x1b[2;1Hcharlie"), true);
    assert.equal(output.includes("\x1b[2K"), false);
    assert.equal(output.endsWith("\x1b[?25l"), true);
    tui.stop();
  });

  it("appends visible cursor sync after full renders", () => {
    const component = anchorComponent(["alpha"], { column: 2, row: 0, visible: true });
    const tui = new LocalTui({ renderIntervalMs: 1000 });

    tui.setChildren([component]);
    tui.setCursorAnchorTarget(component);
    tui.start();
    flush(tui, true);

    const output = writes.join("");
    assert.equal(output.includes("\x1b[1;1Halpha"), true);
    assert.equal(output.endsWith("\x1b[1;3H\x1b[?25h"), true);
    tui.stop();
  });

  it("appends visible cursor sync after no-diff renders", () => {
    const component = anchorComponent(["alpha"], { column: 4, row: 0, visible: true });
    const tui = new LocalTui({ renderIntervalMs: 1000 });

    tui.setChildren([component]);
    tui.setCursorAnchorTarget(component);
    tui.start();
    flush(tui, true);
    writes = [];

    flush(tui, false);

    assert.equal(writes.join(""), "\x1b[1;5H\x1b[?25h");
    tui.stop();
  });

  it("projects child-local anchors with row offsets", () => {
    const first = mutableComponent(["top"]);
    const second = anchorComponent(["middle", "bottom"], { column: 1, row: 1, visible: true });
    const tui = new LocalTui({ renderIntervalMs: 1000 });

    tui.setChildren([first, second]);
    tui.setCursorAnchorTarget(second);
    tui.start();
    flush(tui, true);

    assert.equal(writes.join("").endsWith("\x1b[3;2H\x1b[?25h"), true);
    tui.stop();
  });

  it("hides the cursor when no target exists or the target is hidden", () => {
    const component = anchorComponent(["alpha"], { column: 0, row: 0, visible: false });
    const tui = new LocalTui({ renderIntervalMs: 1000 });

    tui.setChildren([component]);
    tui.start();
    flush(tui, true);
    assert.equal(writes.join("").endsWith("\x1b[?25l"), true);

    writes = [];
    tui.setCursorAnchorTarget(component);
    flush(tui, false);
    assert.equal(writes.join(""), "\x1b[?25l");
    tui.stop();
  });

  it("hides the cursor for out-of-frame anchors and disabled sync", () => {
    const component = anchorComponent(["alpha"], { column: 12, row: 0, visible: true });
    const disabled = anchorComponent(["bravo"], { column: 0, row: 0, visible: true });
    const tui = new LocalTui({ renderIntervalMs: 1000 });
    const disabledTui = new LocalTui({ cursorSyncEnabled: false, renderIntervalMs: 1000 });

    tui.setChildren([component]);
    tui.setCursorAnchorTarget(component);
    tui.start();
    flush(tui, true);
    assert.equal(writes.join("").endsWith("\x1b[?25l"), true);
    tui.stop();

    writes = [];
    disabledTui.setChildren([disabled]);
    disabledTui.setCursorAnchorTarget(disabled);
    disabledTui.start();
    flush(disabledTui, true);
    assert.equal(writes.join("").endsWith("\x1b[?25l"), true);
    disabledTui.stop();
  });

  it("hides the cursor for non-integer and negative anchors", () => {
    const invalidAnchors = [
      { column: 0, row: Number.NaN, visible: true },
      { column: Number.NaN, row: 0, visible: true },
      { column: 0, row: Number.POSITIVE_INFINITY, visible: true },
      { column: Number.POSITIVE_INFINITY, row: 0, visible: true },
      { column: 0, row: 0.5, visible: true },
      { column: 1.5, row: 0, visible: true },
      { column: 0, row: -1, visible: true },
      { column: -1, row: 0, visible: true },
    ];

    for (const anchor of invalidAnchors) {
      writes = [];
      const component = anchorComponent(["alpha"], anchor);
      const tui = new LocalTui({ renderIntervalMs: 1000 });

      tui.setChildren([component]);
      tui.setCursorAnchorTarget(component);
      tui.start();
      flush(tui, true);

      assert.equal(writes.join("").endsWith("\x1b[?25l"), true);
      assert.equal(writes.join("").includes("\x1b[?25h"), false);
      tui.stop();
    }
  });

  it("uses clear-to-EOL only for shortened rows and trailing row deletion", () => {
    const component = mutableComponent(["longer", "remove"]);
    const tui = new LocalTui({ renderIntervalMs: 1000 });

    tui.setChildren([component]);
    tui.start();
    flush(tui, true);
    writes = [];

    component.lines = ["tiny"];
    flush(tui, false);

    const output = writes.join("");
    assert.equal(output.includes("\x1b[1;1Htiny\x1b[K"), true);
    assert.equal(output.includes("\x1b[2;1H\x1b[K"), true);
    assert.equal(output.includes("\x1b[2K"), false);
    tui.stop();
  });

  it("preserves shortened-row and trailing-row clears during force renders", () => {
    const component = mutableComponent(["longer", "remove"]);
    const tui = new LocalTui({ renderIntervalMs: 1000 });

    tui.setChildren([component]);
    tui.start();
    flush(tui, true);
    writes = [];

    component.lines = ["tiny"];
    flush(tui, true);

    const output = writes.join("");
    assert.equal(output.includes("\x1b[1;1Htiny\x1b[K"), true);
    assert.equal(output.includes("\x1b[2;1H\x1b[K"), true);
    assert.equal(output.includes("\x1b[2J"), false);
    assert.equal(output.includes("\x1b[2K"), false);
    tui.stop();
  });

  it("clears rows selectively on initial main-screen renders", () => {
    const component = mutableComponent(["alpha"]);
    const tui = new LocalTui({ renderIntervalMs: 1000, useAltScreen: false });

    tui.setChildren([component]);
    tui.start();
    flush(tui, true);

    const output = writes.join("");
    assert.equal(output.includes("\x1b[1;1Halpha\x1b[K"), true);
    assert.equal(output.includes("\x1b[2;1H\x1b[K"), true);
    assert.equal(output.includes("\x1b[?1049h"), false);
    assert.equal(output.includes("\x1b[2J"), false);
    assert.equal(output.includes("\x1b[2K"), false);
    tui.stop();
  });

  it("clears shortened rows and trailing rows after alt-screen resize full renders", () => {
    const component = mutableComponent(["widewidewide", "middle", "bottom"]);
    const tui = new LocalTui({ renderIntervalMs: 1000 });

    tui.setChildren([component]);
    tui.start();
    flush(tui, true);
    writes = [];

    component.lines = ["tiny"];
    setTerminalSize(8, 2);
    flush(tui, false);

    const output = writes.join("");
    assert.equal(output.includes("\x1b[1;1Htiny\x1b[K"), true);
    assert.equal(output.includes("\x1b[2;1H\x1b[K"), true);
    assert.equal(output.includes("\x1b[2J"), false);
    tui.stop();
  });

  it("installs one process signal listener for multiple active TUIs", () => {
    const initialSigintListeners = process.listenerCount("SIGINT");
    const initialSigtermListeners = process.listenerCount("SIGTERM");
    const firstTui = new LocalTui({ renderIntervalMs: 1000 });
    const secondTui = new LocalTui({ renderIntervalMs: 1000 });

    firstTui.start();
    secondTui.start();

    assert.equal(process.listenerCount("SIGINT"), initialSigintListeners + 1);
    assert.equal(process.listenerCount("SIGTERM"), initialSigtermListeners + 1);

    firstTui.stop();
    assert.equal(process.listenerCount("SIGINT"), initialSigintListeners + 1);
    assert.equal(process.listenerCount("SIGTERM"), initialSigtermListeners + 1);

    secondTui.stop();
    assert.equal(process.listenerCount("SIGINT"), initialSigintListeners);
    assert.equal(process.listenerCount("SIGTERM"), initialSigtermListeners);
  });

  it("does not re-enter external signal handlers during signal cleanup", () => {
    const tui = new LocalTui({ renderIntervalMs: 1000 });
    let killCalls = 0;
    let externalSigintCalls = 0;
    const externalSigintHandler = () => {
      externalSigintCalls += 1;
    };

    process.kill = (() => {
      killCalls += 1;
      return true;
    }) as typeof process.kill;
    process.on("SIGINT", externalSigintHandler);
    try {
      tui.start();
      process.emit("SIGINT");

      assert.equal(externalSigintCalls, 1);
      assert.equal(killCalls, 0);
      assert.equal(writes.join("").includes("\x1b[?1049l"), true);
      assert.equal(writes.join("").includes("\x1b[?1006l\x1b[?1002l\x1b[?1000l"), true);
    } finally {
      process.removeListener("SIGINT", externalSigintHandler);
      tui.stop();
    }
  });

  it("re-raises signals only when no external signal listener remains", () => {
    const tui = new LocalTui({ renderIntervalMs: 1000 });
    const killSignals: (NodeJS.Signals | number | undefined)[] = [];

    process.kill = ((_pid: number, signal?: NodeJS.Signals | number) => {
      killSignals.push(signal);
      return true;
    }) as typeof process.kill;

    tui.start();
    process.emit("SIGTERM");

    assert.deepEqual(killSignals, ["SIGTERM"]);
    assert.equal(writes.join("").includes("\x1b[?1049l"), true);
    assert.equal(writes.join("").includes("\x1b[?1006l\x1b[?1002l\x1b[?1000l"), true);
    tui.stop();
  });

  it("cancels pending renders on stop and restores terminal once during process panic cleanup", async () => {
    const initialSigintListeners = process.listenerCount("SIGINT");
    const initialSigtermListeners = process.listenerCount("SIGTERM");
    const initialPanicListeners = process.listenerCount("uncaughtExceptionMonitor");
    const component = mutableComponent(["alpha"]);
    const tui = new LocalTui({ renderIntervalMs: 20 });

    tui.setChildren([component]);
    tui.start();
    tui.stop();
    await delay(30);

    assert.equal(writes.join("").includes("\x1b[1;1Halpha"), false);

    writes = [];
    tui.start();
    process.emit("uncaughtExceptionMonitor", new Error("panic"));
    process.emit("uncaughtExceptionMonitor", new Error("panic again"));

    assert.equal(countWrites("\x1b[?25h"), 1);
    assert.equal(countWrites("\x1b[?1006l"), 1);
    assert.equal(countWrites("\x1b[?1002l"), 1);
    assert.equal(countWrites("\x1b[?1000l"), 1);
    assert.equal(countWrites("\x1b[?1049l"), 1);
    assert.equal(process.listenerCount("SIGINT"), initialSigintListeners);
    assert.equal(process.listenerCount("SIGTERM"), initialSigtermListeners);
    assert.equal(process.listenerCount("uncaughtExceptionMonitor"), initialPanicListeners);
    tui.stop();
  });

  it("preserves external signal listeners during process panic cleanup", () => {
    const initialSigintListeners = process.listenerCount("SIGINT");
    const initialSigtermListeners = process.listenerCount("SIGTERM");
    const initialPanicListeners = process.listenerCount("uncaughtExceptionMonitor");
    const tui = new LocalTui({ renderIntervalMs: 1000 });
    let externalSigintCalls = 0;
    const externalSigintHandler = () => {
      externalSigintCalls += 1;
    };

    process.on("SIGINT", externalSigintHandler);
    try {
      tui.start();
      process.emit("uncaughtExceptionMonitor", new Error("panic"));

      assert.equal(process.listenerCount("SIGINT"), initialSigintListeners + 1);
      assert.equal(process.listenerCount("SIGTERM"), initialSigtermListeners);
      assert.equal(process.listenerCount("uncaughtExceptionMonitor"), initialPanicListeners);

      process.emit("SIGINT");
      assert.equal(externalSigintCalls, 1);
    } finally {
      process.removeListener("SIGINT", externalSigintHandler);
      tui.stop();
    }
  });
});

function countWrites(sequence: string): number {
  return writes.join("").split(sequence).length - 1;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function flush(tui: LocalTui, force: boolean): void {
  (tui as unknown as { flushRender: (force: boolean) => void }).flushRender(force);
}

function setTerminalSize(columns: number | undefined, rows: number | undefined): void {
  Object.defineProperty(process.stdout, "columns", {
    configurable: true,
    value: columns,
  });
  Object.defineProperty(process.stdout, "rows", {
    configurable: true,
    value: rows,
  });
}

function mutableComponent(lines: string[]): Component & { lines: string[] } {
  return {
    invalidate() {},
    lines,
    render() {
      return this.lines;
    },
  };
}

function anchorComponent(lines: string[], anchor: NonNullable<ReturnType<NonNullable<Component["getCursorAnchor"]>>>): Component & { lines: string[] } {
  return {
    getCursorAnchor() {
      return anchor;
    },
    invalidate() {},
    lines,
    render() {
      return this.lines;
    },
  };
}
