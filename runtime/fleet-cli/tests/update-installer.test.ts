import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolvePathBinary } from "../src/process/resolve-bin.js";
import { readFleetCliRelease } from "../src/release.js";
import { checkUpdateStatus } from "../src/update/check.js";
import { __installerTestHooks, runFleetUpdate } from "../src/update/installer.js";
import type { UpdateCommandIo } from "../src/update/types.js";

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

vi.mock("../src/release.js", () => ({
  readFleetCliRelease: vi.fn(),
}));

vi.mock("../src/update/check.js", () => ({
  checkUpdateStatus: vi.fn(),
  resolveUpdateChannel: vi.fn(() => "latest"),
}));

vi.mock("../src/process/resolve-bin.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/process/resolve-bin.js")>();
  return {
    ...actual,
    resolvePathBinary: vi.fn(),
  };
});

const TEMP_DIRS: string[] = [];
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

  afterEach(() => {
    for (const dir of TEMP_DIRS.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["npm", "C:\\tools\\npm.cmd"] as const,
    ["pnpm", "C:\\tools\\pnpm.cmd"] as const,
  ])("detects global %s installs through resolved Windows shim argv", (command, shimPath) => {
    const globalRoot = makePackageGlobalRoot();
    const io = createIo();
    mockedResolvePathBinary.mockReturnValue(createWindowsResolvedShim(shimPath));
    mockedExecFileSync.mockReturnValue(`${globalRoot}\n`);

    const result = __installerTestHooks.detectGlobalRoot(command, path.join(globalRoot, "@dotobokuri", "fleet-cli"), io);

    expect(result?.manager?.command).toBe(command);
    expect(result?.manager?.resolved).toEqual(createWindowsResolvedShim(shimPath));
    expect(mockedExecFileSync).toHaveBeenCalledWith("C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", "call", `${shimPath} `, "root", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(io.stderr.toString()).toBe("");
  });

  it("does not report missing package manager binaries as detection errors", () => {
    const io = createIo();
    mockedResolvePathBinary.mockReturnValue(undefined);

    const result = __installerTestHooks.detectGlobalRoot("npm", makePackageGlobalRoot(), io);

    expect(result).toBeUndefined();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
    expect(io.stderr.toString()).toBe("");
  });

  it("reports npm root execution errors during detection", () => {
    const io = createIo();
    mockedResolvePathBinary.mockReturnValue({ bin: "npm", prefixArgs: [] });
    mockedExecFileSync.mockImplementation(() => {
      const error = new Error("Command failed");
      (error as Error & { stderr: Buffer }).stderr = Buffer.from("npm exploded");
      throw error;
    });

    const result = __installerTestHooks.detectGlobalRoot("npm", makePackageGlobalRoot(), io);

    expect(result).toBeUndefined();
    expect(io.stderr.toString()).toContain("Failed to detect Fleet's global npm install: npm exploded");
  });

  it("reports resolver errors during detection without crashing", () => {
    const io = createIo();
    mockedResolvePathBinary.mockImplementation(() => {
      throw new Error("Refusing to run Windows shim path with cmd.exe expansion-sensitive characters");
    });

    const result = __installerTestHooks.detectGlobalRoot("npm", makePackageGlobalRoot(), io);

    expect(result).toBeUndefined();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
    expect(io.stderr.toString()).toContain("Failed to detect Fleet's global npm install: Refusing to run Windows shim path");
  });

  it("treats missing package manager binaries as quiet non-global detection", () => {
    const io = createIo();
    mockedResolvePathBinary.mockReturnValue(undefined);

    const result = __installerTestHooks.detectGlobalRoot("pnpm", makePackageGlobalRoot(), io);

    expect(result).toBeUndefined();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
    expect(io.stderr.toString()).toBe("");
  });

  it("installs with the stored resolved Windows shim argv", async () => {
    const child = new EventEmitter();
    const io = createIo();
    mockedSpawn.mockReturnValue(child as ReturnType<typeof spawn>);

    const statusPromise = __installerTestHooks.installFleetPackages(
      {
        command: "pnpm",
        globalRoot: "C:\\global",
        resolved: createWindowsResolvedShim("C:\\tools\\pnpm.cmd"),
      },
      "latest",
      io,
    );
    child.emit("exit", 0, null);

    await expect(statusPromise).resolves.toBe(0);
    expect(mockedSpawn).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/s", "/c", "call", "C:\\tools\\pnpm.cmd ", "i", "-g", "@dotobokuri/fleet-cli@latest", "@dotobokuri/fleet-console@latest"],
      { stdio: "inherit" },
    );
    expect(io.stderr.toString()).toBe("");
  });

  it("installs POSIX managers as bare argv targets", async () => {
    const child = new EventEmitter();
    const io = createIo();
    mockedSpawn.mockReturnValue(child as ReturnType<typeof spawn>);

    const statusPromise = __installerTestHooks.installFleetPackages(
      {
        command: "npm",
        globalRoot: "/usr/local/lib/node_modules",
        resolved: { bin: "/usr/local/bin/npm", prefixArgs: [] },
      },
      "1.2.3",
      io,
    );
    child.emit("exit", 0, null);

    await expect(statusPromise).resolves.toBe(0);
    expect(mockedSpawn).toHaveBeenCalledWith(
      "/usr/local/bin/npm",
      ["i", "-g", "@dotobokuri/fleet-cli@1.2.3", "@dotobokuri/fleet-console@1.2.3"],
      { stdio: "inherit" },
    );
  });

  it("reports spawn errors before returning installer failure", async () => {
    const child = new EventEmitter();
    const io = createIo();
    mockedSpawn.mockReturnValue(child as ReturnType<typeof spawn>);

    const statusPromise = __installerTestHooks.installFleetPackages(
      {
        command: "npm",
        globalRoot: "/global",
        resolved: { bin: "/bin/npm", prefixArgs: [] },
      },
      "latest",
      io,
    );
    child.emit("error", new Error("spawn failed"));

    await expect(statusPromise).resolves.toBe(1);
    expect(io.stderr.toString()).toContain("Failed to run npm installer: spawn failed");
  });

  it("prints local development guidance without detecting or installing", async () => {
    const io = createIo();
    mockedReadFleetCliRelease.mockReturnValue({ channel: "local", version: "1.2.0" });

    await expect(runFleetUpdate(io)).resolves.toBe(0);

    expect(io.stdout.toString()).toBe(
      "Fleet is running from a local development build (v1.2.0) — nothing to update here.\n",
    );
    expect(mockedResolvePathBinary).not.toHaveBeenCalled();
    expect(mockedSpawn).not.toHaveBeenCalled();
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

  it("prints stable local-detection guidance when no global manager is found", async () => {
    const io = createIo();
    mockedResolvePathBinary.mockReturnValue(undefined);

    await expect(runFleetUpdate(io)).resolves.toBe(0);

    expect(io.stdout.toString()).toBe(
      [
        "Fleet could not detect its global npm or pnpm installation, so no installer was run.",
        "Run one of these commands manually:",
        "npm i -g @dotobokuri/fleet-cli@latest @dotobokuri/fleet-console@latest",
        "pnpm i -g @dotobokuri/fleet-cli@latest @dotobokuri/fleet-console@latest",
        "",
      ].join("\n"),
    );
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
        "npm i -g @dotobokuri/fleet-cli@latest @dotobokuri/fleet-console@latest",
        "pnpm i -g @dotobokuri/fleet-cli@latest @dotobokuri/fleet-console@latest",
        "",
      ].join("\n"),
    );
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it("installs the confirmed newer version with the detected manager", async () => {
    const child = new EventEmitter();
    const io = createIo();
    mockedResolvePathBinary.mockReturnValue({ bin: "npm", prefixArgs: [] });
    mockedExecFileSync.mockReturnValue(`${process.cwd()}\n`);
    mockedCheckUpdateStatus.mockResolvedValue({ status: "update", latest: "1.3.0" });
    mockedSpawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return child as ReturnType<typeof spawn>;
    });

    await expect(runFleetUpdate(io)).resolves.toBe(0);

    expect(io.stdout.toString()).toBe("Updating Fleet packages with npm (1.3.0)...\n");
    expect(mockedSpawn).toHaveBeenCalledWith(
      "npm",
      ["i", "-g", "@dotobokuri/fleet-cli@1.3.0", "@dotobokuri/fleet-console@1.3.0"],
      { stdio: "inherit" },
    );
  });

  it("reinstalls latest with the detected manager when registry status is unavailable", async () => {
    const child = new EventEmitter();
    const io = createIo();
    mockedResolvePathBinary.mockReturnValue({ bin: "npm", prefixArgs: [] });
    mockedExecFileSync.mockReturnValue(`${process.cwd()}\n`);
    mockedCheckUpdateStatus.mockResolvedValue({ status: "unavailable" });
    mockedSpawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return child as ReturnType<typeof spawn>;
    });

    await expect(runFleetUpdate(io)).resolves.toBe(0);
    expect(io.stdout.toString()).toBe("Could not reach the npm registry to check for updates; reinstalling the latest published version with npm...\n");
    expect(mockedSpawn).toHaveBeenCalledWith(
      "npm",
      ["i", "-g", "@dotobokuri/fleet-cli@latest", "@dotobokuri/fleet-console@latest"],
      { stdio: "inherit" },
    );
  });
});

function makePackageGlobalRoot(): string {
  const globalRoot = mkdtempSync(path.join(os.tmpdir(), "fleet-update-global-"));
  TEMP_DIRS.push(globalRoot);
  mkdirSync(path.join(globalRoot, "@dotobokuri", "fleet-cli"), { recursive: true });
  return globalRoot;
}

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
