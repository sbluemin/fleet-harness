import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UpdateCommandIo } from "../../cli/update/dispatcher.js";

interface StringWriter {
  write(chunk: string): boolean;
  toString(): string;
}

const resolvePathBinaryMock = vi.hoisted(() =>
  vi.fn<(command: string, env: NodeJS.ProcessEnv) => { bin: string; prefixArgs: readonly string[] } | undefined>(),
);

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("@dotobokuri/core-process", () => ({
  resolvePathBinary: (...args: Parameters<typeof resolvePathBinaryMock>) => resolvePathBinaryMock(...args),
}));

const { resolveSiblingConsoleCliPath, stopRunningConsoleBeforeUpdate } = await import("../../cli/update/stop-console.js");
const mockedSpawn = vi.mocked(spawn);
const TEMP_DIRS: string[] = [];

describe("stopRunningConsoleBeforeUpdate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const dir of TEMP_DIRS.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops the running console via sibling dist/cli.mjs before updating", async () => {
    const child = makeChild();
    mockedSpawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return child as unknown as ReturnType<typeof spawn>;
    });
    const io = createIo();

    await stopRunningConsoleBeforeUpdate(io, { siblingCliPath: "/pkg/dist/cli.mjs" });

    expect(resolvePathBinaryMock).not.toHaveBeenCalled();
    expect(mockedSpawn).toHaveBeenCalledWith(
      process.execPath,
      ["/pkg/dist/cli.mjs", "stop"],
      { stdio: "ignore" },
    );
    expect(io.stdout.toString()).toContain("Stopping the running Fleet Console");
  });

  it("kills the stop process and continues after the timeout", async () => {
    vi.useFakeTimers();
    const child = makeChild();
    resolvePathBinaryMock.mockReturnValue({ bin: "/usr/local/bin/fleet-console", prefixArgs: [] });
    mockedSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const io = createIo();

    const promise = stopRunningConsoleBeforeUpdate(io, { siblingCliPath: "" });
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(promise).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(io.stderr.toString()).toContain("did not stop within the timeout");
  });
});

function makeChild(): EventEmitter & { kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
  child.kill = vi.fn();
  return child;
}

function createIo(): UpdateCommandIo & { readonly stderr: StringWriter; readonly stdout: StringWriter } {
  return {
    stderr: createStringWriter(),
    stdout: createStringWriter(),
  };
}

function createStringWriter(): StringWriter {
  let value = "";
  return {
    write(chunk: string): boolean {
      value += chunk;
      return true;
    },
    toString(): string {
      return value;
    },
  };
}
