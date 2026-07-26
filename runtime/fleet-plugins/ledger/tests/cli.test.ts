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
  it("triggers the pinned npm install when the installed version differs", async () => {
    const cliHome = await cliHomeWithVersion("4.6.0");
    const install = vi.fn<InstallExecutor>(async () => {
      await writeInstallation(cliHome, TOKSCALE_VERSION);
    });
    await expect(ensureTokscaleBin(cliHome, install)).resolves.toBe(
      await fs.realpath(path.join(cliHome, "node_modules", "tokscale", "bin.js")),
    );
    expect(install).toHaveBeenCalledOnce();
    expect(install.mock.calls[0]?.[1]).toEqual([
      "install", `tokscale@${TOKSCALE_VERSION}`,
      "--prefix", cliHome,
      "--global=false", "--force=false", "--no-audit", "--no-fund", "--loglevel=error",
    ]);
    expect(install.mock.calls[0]?.[2]).toBe(TOKSCALE_TIMEOUT_MS);
  });

  it("does not cache a failed bootstrap and retries the next call", async () => {
    const cliHome = await cliHomeWithVersion("0.0.0");
    const install = vi.fn<InstallExecutor>(async () => {
      throw new Error("temporary network failure");
    });
    await expect(ensureTokscaleBin(cliHome, install)).rejects.toThrow("temporary network failure");
    await expect(ensureTokscaleBin(cliHome, install)).rejects.toThrow("temporary network failure");
    expect(install).toHaveBeenCalledTimes(2);
  });

  it("reinstalls when the pinned manifest exists without bin.js", async () => {
    const cliHome = await cliHomeWithVersion(TOKSCALE_VERSION, false);
    const install = vi.fn<InstallExecutor>(async () => {
      await writeInstallation(cliHome, TOKSCALE_VERSION);
    });
    await ensureTokscaleBin(cliHome, install);
    expect(install).toHaveBeenCalledOnce();
  });

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

  it("passes npm a sanitized, plugin-local environment", async () => {
    const cliHome = await cliHomeWithVersion("0.0.0");
    const install = vi.fn<InstallExecutor>(async () => {
      await writeInstallation(cliHome, TOKSCALE_VERSION);
    });
    await ensureTokscaleBin(cliHome, install);
    const env = install.mock.calls[0]?.[3];
    expect(env).toMatchObject({
      npm_config_registry: "https://registry.npmjs.org/",
      npm_config_userconfig: path.join(cliHome, ".npmrc-disabled-user"),
      npm_config_globalconfig: path.join(cliHome, ".npmrc-disabled-global"),
      npm_config_cache: path.join(cliHome, ".npm-cache"),
    });
    expect(env).not.toHaveProperty("NODE_OPTIONS");
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
      'fs.writeFileSync(process.argv[2], String(child.pid));',
      'setInterval(() => {}, 1000);',
    ].join("\n"));
    const result = await createDefaultExecutor(cliHome)([pidFile], { cwd: cliHome, timeout: 200 });
    expect(result.exitCode).not.toBe(0);
    const grandchildPid = Number.parseInt(await fs.readFile(pidFile, "utf8"), 10);
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
