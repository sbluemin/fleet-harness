import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveXaiCliClientVersion, XAI_CLI_FALLBACK_CLIENT_VERSION } from "../../src/xai/cli-version.js";
import type { CredentialResolverDeps } from "../../src/transport/credentials.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await fs.rm(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

async function grokHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-grok-home-"));
  temporaryDirectories.push(dir);
  return dir;
}

function deps(overrides: Partial<CredentialResolverDeps> = {}): CredentialResolverDeps {
  return {
    platform: "darwin",
    homedir: () => "/nonexistent-home",
    env: {},
    readBounded: async () => null,
    execFile: async () => { throw new Error("no grok on PATH"); },
    ...overrides,
  };
}

describe("Grok CLI client version", () => {
  it("prefers an explicit override", async () => {
    const execFile = vi.fn(async () => "grok 1.0.5");
    await expect(resolveXaiCliClientVersion({
      deps: deps({ env: { FLEET_XAI_CLI_VERSION: "2.3.4" }, execFile }),
    })).resolves.toBe("2.3.4");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("reads the installer symlink before anything that costs more", async () => {
    const home = await grokHome();
    await fs.mkdir(path.join(home, "bin"));
    await fs.symlink("grok-1.2.3", path.join(home, "bin", "grok"));
    const readBounded = vi.fn(async () => "9.9.9");
    const execFile = vi.fn(async () => "grok 9.9.9");
    await expect(resolveXaiCliClientVersion({
      deps: deps({ env: { GROK_HOME: home }, readBounded, execFile }),
    })).resolves.toBe("1.2.3");
    expect(readBounded).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("falls through to the marker file when there is no symlink", async () => {
    const home = await grokHome();
    const execFile = vi.fn(async () => "grok 9.9.9");
    await expect(resolveXaiCliClientVersion({
      deps: deps({ env: { GROK_HOME: home }, readBounded: async () => "1.0.7\n", execFile }),
    })).resolves.toBe("1.0.7");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("runs the installed executable by absolute path on Windows, where there is no symlink", async () => {
    // The Windows updater copies the new binary over `bin\\grok.exe`, so nothing on disk names
    // the version and the marker file may lag a fresh install that has not been run yet.
    const home = await grokHome();
    const execFile = vi.fn(async (file: string) => {
      if (file !== path.join(home, "bin", "grok.exe")) throw new Error(`unexpected file: ${file}`);
      return "grok 1.6.2 (deadbee) [stable]\n";
    });
    await expect(resolveXaiCliClientVersion({
      deps: deps({ platform: "win32", env: { GROK_HOME: home }, execFile }),
    })).resolves.toBe("1.6.2");
  });

  it("falls through to PATH when the Grok home holds no executable", async () => {
    const home = await grokHome();
    const execFile = vi.fn(async (file: string) => {
      // A Windows npm install leaves a `grok.cmd` shim on PATH, which `execFile` refuses to
      // run without a shell; the home copy is simply absent here.
      if (file === "grok") return "grok 1.7.0";
      throw new Error("ENOENT");
    });
    await expect(resolveXaiCliClientVersion({
      deps: deps({ platform: "win32", env: { GROK_HOME: home }, execFile }),
    })).resolves.toBe("1.7.0");
    expect(execFile.mock.calls.map(([file]) => file)).toEqual([
      path.join(home, "bin", "grok.exe"),
      "grok",
    ]);
  });

  it("spawns the CLI only when the filesystem says nothing", async () => {
    await expect(resolveXaiCliClientVersion({
      deps: deps({ execFile: async () => "grok 1.4.0 (abc1234) [stable]\n" }),
    })).resolves.toBe("1.4.0");
  });

  it("prefers the marker file over any spawn", async () => {
    const home = await grokHome();
    const execFile = vi.fn(async () => "grok 9.9.9");
    await expect(resolveXaiCliClientVersion({
      deps: deps({ platform: "win32", env: { GROK_HOME: home }, readBounded: async () => "1.5.1", execFile }),
    })).resolves.toBe("1.5.1");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("falls back to a constant rather than sending no version at all", async () => {
    // The proxy answers 426 to a request with no `x-grok-client-version`, so an absent header is
    // strictly worse than a stale number.
    await expect(resolveXaiCliClientVersion({ deps: deps() }))
      .resolves.toBe(XAI_CLI_FALLBACK_CLIENT_VERSION);
  });

  it("ignores a symlink target that carries no version", async () => {
    const home = await grokHome();
    await fs.mkdir(path.join(home, "bin"));
    await fs.symlink("grok", path.join(home, "bin", "grok"));
    await expect(resolveXaiCliClientVersion({
      deps: deps({ env: { GROK_HOME: home }, readBounded: async () => "1.0.9" }),
    })).resolves.toBe("1.0.9");
  });
});
