import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UpdateCommandIo } from "../src/update/types.js";

interface StringWriter {
  write(chunk: string): boolean;
  toString(): string;
}

const resolveMock = vi.hoisted(() => vi.fn<(specifier: string) => string>());

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:module", () => ({ createRequire: () => ({ resolve: resolveMock }) }));

const { stopRunningConsoleBeforeUpdate } = await import("../src/update/stop-console.js");
const mockedSpawn = vi.mocked(spawn);

describe("stopRunningConsoleBeforeUpdate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops the running console and announces it before updating", async () => {
    const child = makeChild();
    resolveMock.mockReturnValue("/global/@dotobokuri/fleet-console/dist/cli.mjs");
    mockedSpawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return child as ReturnType<typeof spawn>;
    });
    const io = createIo();

    await stopRunningConsoleBeforeUpdate(io);

    expect(mockedSpawn).toHaveBeenCalledWith(
      process.execPath,
      ["/global/@dotobokuri/fleet-console/dist/cli.mjs", "stop"],
      { stdio: "ignore" },
    );
    expect(io.stdout.toString()).toContain("Stopping the running Fleet Console");
  });

  it("skips silently when fleet-console cannot be resolved", async () => {
    resolveMock.mockImplementation(() => {
      throw new Error("Cannot find module '@dotobokuri/fleet-console/cli'");
    });
    const io = createIo();

    await stopRunningConsoleBeforeUpdate(io);

    expect(mockedSpawn).not.toHaveBeenCalled();
    expect(io.stdout.toString()).toBe("");
  });

  it("continues without throwing when the stop process errors", async () => {
    const child = makeChild();
    resolveMock.mockReturnValue("/path/cli.mjs");
    mockedSpawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("error", new Error("spawn failed")));
      return child as ReturnType<typeof spawn>;
    });
    const io = createIo();

    await expect(stopRunningConsoleBeforeUpdate(io)).resolves.toBeUndefined();
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
  });

  it("kills the stop process and continues after the timeout", async () => {
    vi.useFakeTimers();
    const child = makeChild();
    resolveMock.mockReturnValue("/path/cli.mjs");
    mockedSpawn.mockReturnValue(child as ReturnType<typeof spawn>);
    const io = createIo();

    const promise = stopRunningConsoleBeforeUpdate(io);
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
