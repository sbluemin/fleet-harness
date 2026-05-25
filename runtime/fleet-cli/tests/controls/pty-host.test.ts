import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { IPty } from "node-pty";

import { createPtyHost } from "../../src/controls/pty.js";
import type { PtyExitEvent, PtyLaunchConfig } from "../../src/controls/types.js";

interface FakePty extends IPty {
  emitExit(event: NodePtyExitEvent): void;
}

type NodePtyExitEvent = Parameters<Parameters<IPty["onExit"]>[0]>[0];

const TEST_CONFIG: PtyLaunchConfig = {
  profile: {
    args: [],
    bin: "test",
    cwd: "/tmp",
    env: {},
    terminalName: "xterm-256color",
  },
};

describe("PtyHost exit lifecycle", () => {
  it("notifies exit handlers with exit code and signal", () => {
    const fake = createFakePty();
    const host = createPtyHost(TEST_CONFIG, { startShell: () => fake });
    const events: PtyExitEvent[] = [];

    host.onExit((event) => events.push(event));
    host.start({ cols: 80, rows: 24 });
    fake.emitExit({ exitCode: 7, signal: 15 });

    assert.deepEqual(events, [{ exitCode: 7, signal: 15 }]);
  });

  it("allows multiple exit handlers and ignores duplicate notifications", () => {
    const fake = createFakePty();
    const host = createPtyHost(TEST_CONFIG, { startShell: () => fake });
    const first: PtyExitEvent[] = [];
    const second: PtyExitEvent[] = [];

    host.onExit((event) => first.push(event));
    host.onExit((event) => second.push(event));
    host.start({ cols: 80, rows: 24 });
    fake.emitExit({ exitCode: 0, signal: 0 });
    fake.emitExit({ exitCode: 1, signal: 1 });

    assert.deepEqual(first, [{ exitCode: 0, signal: 0 }]);
    assert.deepEqual(second, [{ exitCode: 0, signal: 0 }]);
  });
});

function createFakePty(): FakePty {
  let exitHandler: ((event: NodePtyExitEvent) => void) | undefined;

  return {
    cols: 80,
    handleFlowControl: false,
    onData: () => ({ dispose: () => undefined }),
    onExit: (handler) => {
      exitHandler = handler;
      return { dispose: () => undefined };
    },
    pid: 123,
    process: "test",
    resize: () => undefined,
    rows: 24,
    write: () => undefined,
    clear: () => undefined,
    kill: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    emitExit(event: NodePtyExitEvent): void {
      exitHandler?.(event);
    },
  };
}
