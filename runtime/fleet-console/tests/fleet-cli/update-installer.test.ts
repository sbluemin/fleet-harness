import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolvePathBinary } from "@dotobokuri/core-process";
import { readFleetCliRelease } from "../../cli/release.js";
import { checkUpdateStatus } from "../../cli/update/check.js";
import { __installerTestHooks, runFleetUpdate } from "../../cli/update/installer.js";
import type { UpdateCommandIo } from "../../cli/update/dispatcher.js";

interface StringWriter {
  write(chunk: string): boolean;
  toString(): string;
}

const fsMock = vi.hoisted(() => ({
  accessSync: vi.fn<typeof fs.accessSync>(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  fsMock.accessSync.mockImplementation(actual.accessSync);
  return {
    ...actual,
    accessSync: fsMock.accessSync,
  };
});

vi.mock("../../cli/release.js", () => ({
  readFleetCliRelease: vi.fn(),
}));

vi.mock("../../cli/update/check.js", () => ({
  checkUpdateStatus: vi.fn(),
  resolveUpdateChannel: vi.fn(() => "latest"),
}));

vi.mock("@dotobokuri/core-process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dotobokuri/core-process")>();
  return {
    ...actual,
    resolvePathBinary: vi.fn(),
  };
});

vi.mock("../../cli/update/stop-console.js", () => ({
  resolveSiblingConsoleCliPath: vi.fn().mockReturnValue(undefined),
  stopRunningConsoleBeforeUpdate: vi.fn().mockResolvedValue(undefined),
}));

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedCheckUpdateStatus = vi.mocked(checkUpdateStatus);
const mockedReadFleetCliRelease = vi.mocked(readFleetCliRelease);
const mockedResolvePathBinary = vi.mocked(resolvePathBinary);
const mockedSpawn = vi.mocked(spawn);
const originalAccessSync = fsMock.accessSync.getMockImplementation();

describe("update installer process invocation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.accessSync.mockImplementation(originalAccessSync!);
    mockedReadFleetCliRelease.mockReturnValue({ channel: "stable", version: "1.2.0" });
    mockedCheckUpdateStatus.mockResolvedValue({ status: "unavailable" });
  });

  it("does not install when the registry confirms Fleet is current", async () => {
    const io = createIo();
    mockedResolvePathBinary.mockReturnValue({ bin: "npm", prefixArgs: [] });
    mockedExecFileSync.mockReturnValue(`${process.cwd()}\n`);
    mockedCheckUpdateStatus.mockResolvedValue({ status: "current", latest: "1.2.0" });

    await expect(runFleetUpdate(io)).resolves.toBe(0);

    expect(io.stdout.toString()).toBe("Fleet is already on the latest version (v1.2.0).\n");
    expect(mockedCheckUpdateStatus).toHaveBeenCalledWith({ channel: "stable", version: "1.2.0" }, { forceRefresh: true });
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it("prints permission guidance when the global install location is not writable", async () => {
    const io = createIo();
    fsMock.accessSync.mockImplementation(() => {
      throw new Error("not writable");
    });
    mockedResolvePathBinary.mockReturnValue({ bin: "npm", prefixArgs: [] });
    mockedExecFileSync.mockReturnValue(`${process.cwd()}\n`);

    try {
      await expect(runFleetUpdate(io)).resolves.toBe(0);
    } finally {
      fsMock.accessSync.mockImplementation(originalAccessSync!);
    }
    expect(io.stdout.toString()).toBe(
      [
        "Fleet's global install location is not writable, so no installer was run.",
        "Run one of these commands manually:",
        "npm i -g @dotobokuri/fleet-console@latest",
        "pnpm i -g @dotobokuri/fleet-console@latest",
        "",
      ].join("\n"),
    );
    expect(mockedSpawn).not.toHaveBeenCalled();
  });
});

function createIo(): UpdateCommandIo & { readonly stderr: StringWriter } {
  return {
    stderr: createStringWriter(),
    stdout: createStringWriter(),
  };
}

function createWindowsResolvedShim(shimPath: string): { readonly bin: string; readonly prefixArgs: readonly string[] } {
  return {
    bin: "C:\\Windows\\System32\\cmd.exe",
    prefixArgs: ["/d", "/s", "/c", "call", `${shimPath} `],
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
