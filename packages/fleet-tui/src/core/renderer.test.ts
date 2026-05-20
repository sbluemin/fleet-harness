import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { LocalTui } from "./renderer.js";
import type { Component } from "../types.js";

const ORIGINAL_COLUMNS = process.stdout.columns;
const ORIGINAL_KILL = process.kill;
const ORIGINAL_ROWS = process.stdout.rows;
const ORIGINAL_WRITE = process.stdout.write;

let writes: string[] = [];

describe("LocalTui", () => {
  beforeEach(() => {
    writes = [];
    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      value: 12,
    });
    Object.defineProperty(process.stdout, "rows", {
      configurable: true,
      value: 4,
    });
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.kill = ORIGINAL_KILL;
    process.stdout.write = ORIGINAL_WRITE;
    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      value: ORIGINAL_COLUMNS,
    });
    Object.defineProperty(process.stdout, "rows", {
      configurable: true,
      value: ORIGINAL_ROWS,
    });
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

    tui.addChild(component);
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

  it("skips identical frames and updates only changed rows", () => {
    const component = mutableComponent(["alpha", "bravo"]);
    const tui = new LocalTui({ renderIntervalMs: 1000 });

    tui.addChild(component);
    tui.start();
    flush(tui, true);
    writes = [];

    flush(tui, false);
    assert.equal(writes.join(""), "");

    component.lines = ["alpha", "charlie"];
    flush(tui, false);

    const output = writes.join("");
    assert.equal(output.includes("\x1b[1;1H"), false);
    assert.equal(output.includes("\x1b[2;1Hcharlie"), true);
    assert.equal(output.includes("\x1b[2K"), false);
    tui.stop();
  });

  it("uses clear-to-EOL only for shortened rows and trailing row deletion", () => {
    const component = mutableComponent(["longer", "remove"]);
    const tui = new LocalTui({ renderIntervalMs: 1000 });

    tui.addChild(component);
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

    tui.addChild(component);
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

    tui.addChild(component);
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
    tui.stop();
  });

  it("cancels pending renders on stop and restores terminal once during process panic cleanup", async () => {
    const initialSigintListeners = process.listenerCount("SIGINT");
    const initialSigtermListeners = process.listenerCount("SIGTERM");
    const initialPanicListeners = process.listenerCount("uncaughtExceptionMonitor");
    const component = mutableComponent(["alpha"]);
    const tui = new LocalTui({ renderIntervalMs: 20 });

    tui.addChild(component);
    tui.start();
    tui.stop();
    await delay(30);

    assert.equal(writes.join("").includes("\x1b[1;1Halpha"), false);

    writes = [];
    tui.start();
    process.emit("uncaughtExceptionMonitor", new Error("panic"));
    process.emit("uncaughtExceptionMonitor", new Error("panic again"));

    assert.equal(countWrites("\x1b[?25h"), 1);
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

function mutableComponent(lines: string[]): Component & { lines: string[] } {
  return {
    invalidate() {},
    lines,
    render() {
      return this.lines;
    },
  };
}
