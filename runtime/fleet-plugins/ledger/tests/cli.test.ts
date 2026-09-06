import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDefaultExecutor, createNpmInstallEnv, ensureTokscaleBin, type InstallExecutor, resetCliStateForTest, TOKSCALE_TIMEOUT_MS, TOKSCALE_VERSION } from "../server/cli.js";

const temporaryDirectories: string[] = [];

beforeEach(() => resetCliStateForTest());
afterEach(async () => {
  resetCliStateForTest();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function writeInstallation(cliHome: string, version: string, withBin = true): Promise<void> {
  const packageDirectory = path.join(cliHome, "node_modules", "tokscale");
  await fs.mkdir(packageDirectory, { recursive: true });
  await fs.writeFile(path.join(packageDirectory, "package.json"), JSON.stringify({ version }));
  if (withBin) await fs.writeFile(path.join(packageDirectory, "bin.js"), "#!/usr/bin/env node\n");
}

async function cliHomeWithVersion(version: string, withBin = true): Promise<string> {
  const cliHome = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-cli-test-"));
  temporaryDirectories.push(cliHome);
  await writeInstallation(cliHome, version, withBin);
  return cliHome;
}

describe("tokscale bootstrap", () => {

  it("reinstalls when bin.js resolves outside cliHome", async () => {
    const cliHome = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-cli-home-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-cli-outside-"));
    temporaryDirectories.push(cliHome, outside);
    await writeInstallation(outside, TOKSCALE_VERSION);
    await fs.mkdir(path.join(cliHome, "node_modules"), { recursive: true });
    await fs.symlink(outside, path.join(cliHome, "node_modules", "tokscale"), "dir");
    const install = vi.fn<InstallExecutor>(async () => {
      await fs.unlink(path.join(cliHome, "node_modules", "tokscale"));
      await writeInstallation(cliHome, TOKSCALE_VERSION);
    });
    await ensureTokscaleBin(cliHome, install);
    expect(install).toHaveBeenCalledOnce();
  });

  it("does not copy NODE_OPTIONS or npm registry overrides into the install environment", () => {
    const env = createNpmInstallEnv("/plugin/cli", {
      PATH: "/bin",
      NODE_OPTIONS: "--require /tmp/injected.js",
      npm_config_registry: "https://malicious.invalid/",
    });
    expect(env.PATH).toBe("/bin");
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.npm_config_registry).toBe("https://registry.npmjs.org/");
  });

  it.skipIf(process.platform === "win32")("kills the POSIX process group when tokscale times out", async () => {
    const cliHome = await cliHomeWithVersion(TOKSCALE_VERSION);
    const pidFile = path.join(cliHome, "grandchild.pid");
    const binPath = path.join(cliHome, "node_modules", "tokscale", "bin.js");
    await fs.writeFile(binPath, [
      'import { spawn } from "node:child_process";',
      'import fs from "node:fs";',
      'const child = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'child.on("spawn", () => { fs.writeFileSync(process.argv[2], String(child.pid)); });',
      'setInterval(() => {}, 1000);',
    ].join("\n"));
    const run = createDefaultExecutor(cliHome)([pidFile], { cwd: cliHome, timeout: 1_500 });
    const grandchildPid = await vi.waitFor(async () => {
      const raw = await fs.readFile(pidFile, "utf8").catch(() => "");
      const pid = Number.parseInt(raw, 10);
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      return pid;
    }, { timeout: 1_000 });
    expect(isProcessAlive(grandchildPid)).toBe(true);
    const result = await run;
    expect(result.exitCode).not.toBe(0);
    await vi.waitFor(() => {
      expect(isProcessAlive(grandchildPid)).toBe(false);
    }, { timeout: 2_000 });
  });
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
