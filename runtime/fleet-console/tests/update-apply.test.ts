import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createConsoleUpdateApplyService, emitConsoleUpdateWorkerScript, type ConsoleUpdateWorkerScriptConfig } from "../core/host/update-apply.js";
import { DESKTOP_RESOURCE_ROOT_MARKER, formatDesktopResourceRootMarker } from "@fleet-console/desktop-protocol";

const TEMP_DIRS: string[] = [];
afterEach(() => { for (const dir of TEMP_DIRS.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("console update apply worker", () => {

  it("rejects worker spawn before writing the worker when no current global manager matches", async () => {
    const writes: string[] = [];
    const service = createConsoleUpdateApplyService({
      preflightInstall: () => {
        throw new Error("no supported global package manager found");
      },
      tmpDir: "/tmp",
      writeFile: (filePath) => {
        writes.push(filePath);
      },
      spawnWorker: () => {
        throw new Error("must not spawn");
      },
    });

    await expect(service.start({
      currentEndpoint: "http://127.0.0.1:4000/",
      currentPackageRoot: "/not-a-global-install",
      currentPid: 111,
      dataDir: "/data/console",
      fromVersion: "1.2.2",
      lockFile: "/tmp/console.lock",
      targetVersion: "1.2.3",
    })).rejects.toThrow("no supported global package manager found");

    expect(writes).toEqual([]);
  });

  it("refuses a marked managed console/latest layout before it can stop or mutate a live runtime", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-update-managed-"));
    TEMP_DIRS.push(root);
    const latest = path.join(root, "console", "latest");
    fs.mkdirSync(latest, { recursive: true });
    fs.writeFileSync(path.join(latest, DESKTOP_RESOURCE_ROOT_MARKER), formatDesktopResourceRootMarker());
    const preflightInstall = vi.fn(() => createPackageManagerSpec());
    const writeFile = vi.fn();
    const service = createConsoleUpdateApplyService({ preflightInstall, writeFile, spawnWorker: () => { throw new Error("must not spawn"); } });

    await expect(service.start({ currentEndpoint: "http://127.0.0.1:4000/", currentPackageRoot: latest, currentPid: 111, dataDir: root, fromVersion: "1.2.2", lockFile: path.join(root, "console.lock"), targetVersion: "1.2.3" })).rejects.toThrow("managed_runtime_update_requires_relaunch");
    expect(preflightInstall).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

});

function createConfig(): ConsoleUpdateWorkerScriptConfig {
  return {
    currentEndpoint: "http://127.0.0.1:4000/",
    currentPackageRoot: "/pkg",
    currentPid: 111,
    fromVersion: "1.2.2",
    lockFile: "/tmp/console.lock",
    logFile: "/tmp/fleet-console-update.log",
    packageManager: createPackageManagerSpec(),
    packageNames: ["@dotobokuri/fleet-console"],
    progressFile: "/data/console/update-progress.json",
    resumePort: 4000,
    serverModulePath: "/pkg/dist/cli.mjs",
    startedAt: "2026-08-19T00:00:00.000Z",
    statusFile: "/tmp/fleet-console-update.status.json",
    targetVersion: "1.2.3",
    workerPath: "/tmp/fleet-console-update.mjs",
  };
}

function createPackageManagerSpec() {
  return {
    bin: "/resolved/npm.cmd",
    command: "npm" as const,
    globalRoot: "/global/root",
    prefixArgs: ["/d", "/s", "/c", "call", "/resolved/npm.cmd "],
  };
}
