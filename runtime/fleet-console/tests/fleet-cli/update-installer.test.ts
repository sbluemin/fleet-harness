import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolvePathBinary } from "@fleet-console/process";
import { readFleetCliRelease } from "../../cli/release.js";
import { checkUpdateStatus } from "../../cli/update/check.js";
import { __installerTestHooks, runFleetUpdate } from "../../cli/update/installer.js";
import { isManagedRuntimePackageRoot } from "../../features/updates/host/update-apply.js";
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

vi.mock("../../cli/update/check.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../cli/update/check.js")>(),
  checkUpdateStatus: vi.fn(),
}));

vi.mock("../../features/updates/host/update-apply.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../features/updates/host/update-apply.js")>(),
  isManagedRuntimePackageRoot: vi.fn().mockReturnValue(false),
}));

vi.mock("@fleet-console/process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fleet-console/process")>();
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
const mockedIsManagedRuntimePackageRoot = vi.mocked(isManagedRuntimePackageRoot);
const mockedCheckUpdateStatus = vi.mocked(checkUpdateStatus);
const mockedReadFleetCliRelease = vi.mocked(readFleetCliRelease);
const mockedResolvePathBinary = vi.mocked(resolvePathBinary);
const mockedSpawn = vi.mocked(spawn);
const originalAccessSync = fsMock.accessSync.getMockImplementation();
const RELEASE_1_3_0 = {
  schema: 1,
  package: "@dotobokuri/fleet-console",
  version: "1.3.0",
  tag: "v1.3.0",
  tarball: { name: "fleet-console-1.3.0.tgz", size: 1, sha256: "0".repeat(64) },
} as const;

describe("update installer process invocation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.accessSync.mockImplementation(originalAccessSync!);
    mockedReadFleetCliRelease.mockReturnValue({ channel: "stable", version: "1.2.0" });
    mockedCheckUpdateStatus.mockResolvedValue({ status: "unavailable" });
    mockedIsManagedRuntimePackageRoot.mockReturnValue(false);
  });

  it("does not install when the release check confirms Fleet is current", async () => {
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
    mockedCheckUpdateStatus.mockResolvedValue({ status: "update", latest: "1.3.0", release: RELEASE_1_3_0 });

    try {
      await expect(runFleetUpdate(io)).resolves.toBe(0);
    } finally {
      fsMock.accessSync.mockImplementation(originalAccessSync!);
    }
    expect(io.stdout.toString()).toBe(
      [
        "Fleet's global install location is not writable, so no installer was run.",
        "Run one of these commands manually:",
        "npm i -g https://github.com/sbluemin/fleet-harness/releases/download/v1.3.0/fleet-console-1.3.0.tgz",
        "pnpm add -g https://github.com/sbluemin/fleet-harness/releases/download/v1.3.0/fleet-console-1.3.0.tgz",
        "",
      ].join("\n"),
    );
    expect(mockedSpawn).not.toHaveBeenCalled();
  });
});

describe("update installer on a Fleet Desktop install", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedReadFleetCliRelease.mockReturnValue({ channel: "stable", version: "1.2.0" });
    mockedCheckUpdateStatus.mockResolvedValue({ status: "update", latest: "1.3.0", release: RELEASE_1_3_0 });
    mockedIsManagedRuntimePackageRoot.mockReturnValue(true);
    vi.stubEnv("FLEET_DESKTOP_CONSOLE_SOURCE", undefined);
  });

  it("points an older Desktop to its own update instead of a global install", async () => {
    const io = createIo();

    // The Console update menu refuses this install with shell_update_required; the CLI must not
    // offer a global install that would leave the running Console unchanged.
    await expect(runFleetUpdate(io)).resolves.toBe(1);

    expect(io.stderr.toString()).toContain("Update Fleet Desktop first");
    expect(io.stdout.toString()).not.toMatch(/npm i -g|pnpm add -g/);
    expect(mockedResolvePathBinary).not.toHaveBeenCalled();
    expect(mockedSpawn).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});

function createIo(): UpdateCommandIo & { readonly stderr: StringWriter } {
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
