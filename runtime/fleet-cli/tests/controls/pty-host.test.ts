import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { IPty } from "node-pty";

import { createPtyHost } from "../../src/controls/pty.js";
import { resolveUseConptyDll } from "../../src/controls/pty/shell.js";
import type { PtyExitEvent, PtyLaunchConfig } from "../../src/controls/types.js";

interface FakePty extends IPty {
  readonly killCount: () => number;
  emitExit(event: NodePtyExitEvent): void;
  throwAlreadyExitedOnKill(): void;
  throwUnexpectedOnKill(): void;
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

    assert.equal(fake.killCount(), 1);
    assert.deepEqual(events, [{ exitCode: 7, signal: 15 }]);
  });

  it("still notifies exit handlers when cleanup kill sees an already-exited pty", () => {
    const fake = createFakePty();
    fake.throwAlreadyExitedOnKill();
    const host = createPtyHost(TEST_CONFIG, { startShell: () => fake });
    const events: PtyExitEvent[] = [];

    host.onExit((event) => events.push(event));
    host.start({ cols: 80, rows: 24 });

    assert.doesNotThrow(() => fake.emitExit({ exitCode: 0, signal: 0 }));
    assert.equal(fake.killCount(), 1);
    assert.deepEqual(events, [{ exitCode: 0, signal: 0 }]);
  });

  it("still notifies exit handlers when cleanup kill throws an unexpected error", () => {
    const fake = createFakePty();
    fake.throwUnexpectedOnKill();
    const host = createPtyHost(TEST_CONFIG, { startShell: () => fake });
    const events: PtyExitEvent[] = [];

    host.onExit((event) => events.push(event));
    host.start({ cols: 80, rows: 24 });

    assert.doesNotThrow(() => fake.emitExit({ exitCode: 0, signal: 0 }));
    assert.equal(fake.killCount(), 1);
    assert.deepEqual(events, [{ exitCode: 0, signal: 0 }]);
  });

  it("ignores resize attempts on a pty that has already exited", () => {
    const fake = createFakePty();
    fake.resize = () => {
      throw new Error("Cannot resize a pty that has already exited");
    };
    const host = createPtyHost(TEST_CONFIG, { startShell: () => fake });
    host.start({ cols: 80, rows: 24 });

    assert.doesNotThrow(() => host.resize(100, 30));
  });

  it("propagates resize errors that are not the exit race", () => {
    const fake = createFakePty();
    fake.resize = () => {
      throw new Error("resizing must be done using positive cols and rows");
    };
    const host = createPtyHost(TEST_CONFIG, { startShell: () => fake });
    host.start({ cols: 80, rows: 24 });

    assert.throws(() => host.resize(0, 0), /positive cols and rows/);
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

describe("resolveUseConptyDll", () => {
  it("defaults on for Windows", () => {
    assert.equal(resolveUseConptyDll("win32", {}), true);
  });

  it("is always off for Linux and Darwin", () => {
    assert.equal(resolveUseConptyDll("linux", { FLEET_USE_CONPTY_DLL: "1" }), false);
    assert.equal(resolveUseConptyDll("darwin", { FLEET_USE_CONPTY_DLL: "1" }), false);
  });

  it("honors the Windows zero override", () => {
    assert.equal(resolveUseConptyDll("win32", { FLEET_USE_CONPTY_DLL: "0" }), false);
  });

  it("honors the Windows false override case-insensitively", () => {
    assert.equal(resolveUseConptyDll("win32", { FLEET_USE_CONPTY_DLL: "FALSE" }), false);
  });

  it("honors the Windows enabled override", () => {
    assert.equal(resolveUseConptyDll("win32", { FLEET_USE_CONPTY_DLL: "1" }), true);
  });
});

function createFakePty(): FakePty {
  let exitHandler: ((event: NodePtyExitEvent) => void) | undefined;
  let killCount = 0;
  let throwAlreadyExited = false;
  let throwUnexpected = false;

  return {
    cols: 80,
    handleFlowControl: false,
    killCount: () => killCount,
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
    kill: () => {
      killCount += 1;
      if (throwAlreadyExited) throw new Error("Cannot kill a pty that has already exited");
      if (throwUnexpected) throw new Error("unexpected kill failure");
    },
    pause: () => undefined,
    resume: () => undefined,
    emitExit(event: NodePtyExitEvent): void {
      exitHandler?.(event);
    },
    throwAlreadyExitedOnKill(): void {
      throwAlreadyExited = true;
    },
    throwUnexpectedOnKill(): void {
      throwUnexpected = true;
    },
  };
}
