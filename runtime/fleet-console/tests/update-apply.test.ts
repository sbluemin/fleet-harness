import { describe, expect, it, vi } from "vitest";

import { createConsoleUpdateApplyService, emitConsoleUpdateWorkerScript, type ConsoleUpdateWorkerScriptConfig } from "../src/update-apply.js";

describe("console update apply worker", () => {
  it("emits a standalone worker script that uses only allowed Node built-ins", () => {
    const script = emitConsoleUpdateWorkerScript(createConfig());

    expect(script).toContain('from "node:child_process"');
    expect(script).toContain('from "node:fs"');
    expect(script).toContain('from "node:os"');
    expect(script).toContain('from "node:path"');
    expect(script).not.toContain('from "@dotobokuri/fleet-cli"');
    expect(script).not.toContain("runtime/fleet-cli");
    expect(script).not.toContain('from "open"');
    expect(script).toContain('"@dotobokuri/fleet-cli"');
    expect(script).toContain('"@dotobokuri/fleet-console"');
    expect(script).toContain('"serve"');
    expect(script).toContain("ensureGlobalRootWritable(manager)");
    expect(script).toContain("writeStatus(\"preflight-ok\"");
    expect(script).toContain("new health response did not expose a version; waiting for verified target");
    expect(script).toContain("return version === config.targetVersion;");
    expect(script).not.toContain('if (command === "npm") return { command };');
    expect(script).not.toContain("target verification skipped");
  });

  it("writes a temporary mjs worker and spawns it detached before returning", async () => {
    const writes: Array<{ readonly filePath: string; readonly content: string; readonly mode: number }> = [];
    const unref = vi.fn();
    const spawned: Array<{ readonly execPath: string; readonly args: readonly string[]; readonly options: unknown }> = [];
    const service = createConsoleUpdateApplyService({
      env: { PATH: "/bin" },
      execPath: "/node",
      makeDir: vi.fn(),
      now: () => 123,
      preflightInstall: () => undefined,
      processPid: 456,
      serverModulePath: "/pkg/dist/cli.mjs",
      tmpDir: "/tmp",
      writeFile: (filePath, content, options) => {
        writes.push({ filePath, content, mode: options.mode });
      },
      spawnWorker: (execPath, args, options) => {
        spawned.push({ execPath, args, options });
        return {
          once: vi.fn().mockReturnThis(),
          unref,
        };
      },
    });

    await expect(service.start({
      currentEndpoint: "http://127.0.0.1:4000/",
      currentPackageRoot: "/pkg",
      currentPid: 111,
      dataDir: "/data/console",
      lockFile: "/tmp/console.lock",
      targetVersion: "1.2.3",
    })).resolves.toEqual({ accepted: true });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.filePath).toBe("/tmp/fleet-console-update-123-456.mjs");
    expect(writes[0]?.content).toContain("/data/console/fleet-console-update-123-456.status.json");
    expect(writes[0]?.content).toContain("/data/console/fleet-console-update-123-456.log");
    expect(writes[0]?.mode).toBe(0o600);
    expect(spawned).toEqual([{
      execPath: "/node",
      args: ["/tmp/fleet-console-update-123-456.mjs"],
      options: { detached: true, env: { PATH: "/bin" }, stdio: "ignore", windowsHide: true },
    }]);
    expect(unref).toHaveBeenCalledTimes(1);
  });

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
      lockFile: "/tmp/console.lock",
      targetVersion: "1.2.3",
    })).rejects.toThrow("no supported global package manager found");

    expect(writes).toEqual([]);
  });
});

function createConfig(): ConsoleUpdateWorkerScriptConfig {
  return {
    currentEndpoint: "http://127.0.0.1:4000/",
    currentPackageRoot: "/pkg",
    currentPid: 111,
    lockFile: "/tmp/console.lock",
    logFile: "/tmp/fleet-console-update.log",
    packageNames: ["@dotobokuri/fleet-cli", "@dotobokuri/fleet-console"],
    serverModulePath: "/pkg/dist/cli.mjs",
    statusFile: "/tmp/fleet-console-update.status.json",
    targetVersion: "1.2.3",
    workerPath: "/tmp/fleet-console-update.mjs",
  };
}
