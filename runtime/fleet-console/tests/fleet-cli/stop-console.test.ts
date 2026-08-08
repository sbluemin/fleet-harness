import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UpdateCommandIo } from "../../cli/update/types.js";

interface StringWriter {
  write(chunk: string): boolean;
  toString(): string;
}

const resolvePathBinaryMock = vi.hoisted(() =>
  vi.fn<(command: string, env: NodeJS.ProcessEnv) => { bin: string; prefixArgs: readonly string[] } | undefined>(),
);

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("@dotobokuri/core-agent", () => ({
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

  it("resolves package-local dist/cli.mjs for both source and built module URLs", () => {
    const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-sibling-"));
    TEMP_DIRS.push(packageRoot);
    fs.mkdirSync(path.join(packageRoot, "cli", "update"), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@dotobokuri/fleet-console" }),
    );
    const expected = path.join(packageRoot, "dist", "cli.mjs");
    fs.writeFileSync(expected, "// fixture\n");

    expect(
      resolveSiblingConsoleCliPath(
        pathToFileURL(path.join(packageRoot, "cli", "update", "stop-console.ts")).href,
      ),
    ).toBe(expected);
    expect(
      resolveSiblingConsoleCliPath(pathToFileURL(path.join(packageRoot, "dist", "fleet.mjs")).href),
    ).toBe(expected);
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

  it("falls back to the PATH fleet-console binary when sibling cli is absent", async () => {
    const child = makeChild();
    resolvePathBinaryMock.mockReturnValue({ bin: "/usr/local/bin/fleet-console", prefixArgs: [] });
    mockedSpawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return child as unknown as ReturnType<typeof spawn>;
    });
    const io = createIo();

    await stopRunningConsoleBeforeUpdate(io, { siblingCliPath: "" });

    expect(resolvePathBinaryMock).toHaveBeenCalledWith("fleet-console", process.env);
    expect(mockedSpawn).toHaveBeenCalledWith(
      "/usr/local/bin/fleet-console",
      ["stop"],
      { stdio: "ignore" },
    );
  });

  it("preserves Windows shim prefix args when stopping fleet-console", async () => {
    const child = makeChild();
    resolvePathBinaryMock.mockReturnValue({
      bin: "C:\\Windows\\System32\\cmd.exe",
      prefixArgs: ["/d", "/s", "/c", "call", "C:\\Users\\me\\AppData\\Roaming\\npm\\fleet-console.cmd"],
    });
    mockedSpawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return child as unknown as ReturnType<typeof spawn>;
    });
    const io = createIo();

    await stopRunningConsoleBeforeUpdate(io, { siblingCliPath: "" });

    expect(mockedSpawn).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/s", "/c", "call", "C:\\Users\\me\\AppData\\Roaming\\npm\\fleet-console.cmd", "stop"],
      { stdio: "ignore" },
    );
  });

  it("skips silently when fleet-console is not on PATH", async () => {
    resolvePathBinaryMock.mockReturnValue(undefined);
    const io = createIo();

    await stopRunningConsoleBeforeUpdate(io, { siblingCliPath: "" });

    expect(mockedSpawn).not.toHaveBeenCalled();
    expect(io.stdout.toString()).toBe("");
  });

  it("skips silently when PATH resolution throws (best-effort)", async () => {
    resolvePathBinaryMock.mockImplementation(() => {
      throw new Error("Refusing to run Windows shim path with cmd.exe expansion-sensitive characters (% or ^): C:\\Users\\%me%\\fleet-console.cmd");
    });
    const io = createIo();

    await expect(stopRunningConsoleBeforeUpdate(io, { siblingCliPath: "" })).resolves.toBeUndefined();
    expect(mockedSpawn).not.toHaveBeenCalled();
    expect(io.stdout.toString()).toBe("");
  });

  it("continues without throwing when the stop process errors", async () => {
    const child = makeChild();
    resolvePathBinaryMock.mockReturnValue({ bin: "/usr/local/bin/fleet-console", prefixArgs: [] });
    mockedSpawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("error", new Error("spawn failed")));
      return child as unknown as ReturnType<typeof spawn>;
    });
    const io = createIo();

    await expect(stopRunningConsoleBeforeUpdate(io, { siblingCliPath: "" })).resolves.toBeUndefined();
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
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
