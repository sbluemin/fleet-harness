import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createConsoleInstallerEnvironment, installConsole, reconcileConsoleInstallations, repairConsoleNativeExecutables, replaceLatest } from "../src/runtime/console-installer.js";
import { resolveRuntimePaths } from "../src/runtime/runtime-paths.js";

function missing(): NodeJS.ErrnoException { const error = new Error("missing") as NodeJS.ErrnoException; error.code = "ENOENT"; return error; }

function fileSystem(existing = new Set<string>()) {
  const stat = vi.fn(async (target: string) => { if (!existing.has(target) && !target.replaceAll("\\", "/").includes(".staging-test/")) throw missing(); });
  const rename = vi.fn(async (from: string, to: string) => { if (!existing.has(from) && !from.includes(".staging-test") && !from.endsWith(".package")) throw missing(); existing.delete(from); existing.add(to); });
  return {
    accessExecutable: vi.fn(async () => undefined),
    chmod: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    readFile: vi.fn(async (target: string) => target.endsWith("package.json") ? JSON.stringify({ version: "1.2.3", engines: { node: ">=22.12.0" } }) : "1\n"),
    readdir: vi.fn(async (target: string) => target.endsWith(".package") ? ["package.json", "dist"] : []),
    rename,
    rm: vi.fn(async (target: string) => { existing.delete(target); }),
    stat,
    writeFile: vi.fn(async () => undefined),
  };
}

describe("console installer", () => {
  it("uses bundled npm, normalizes the prefix package as latest root, and validates before promotion", async () => {
    const fs = fileSystem();
    const run = vi.fn<(command: string, arguments_: readonly string[], options: { readonly env: NodeJS.ProcessEnv }) => Promise<void>>(async () => undefined);
    const paths = resolveRuntimePaths("/Users/fleet");
    const nodeRoot = path.resolve("/runtime/node");
    const staging = path.join(paths.console, ".staging-test");
    await expect(installConsole({ paths, nodeRoot, packageName: "@dotobokuri/fleet-console", version: "1.2.3", nodeRuntimeVersion: "22.23.1", platform: "darwin", architecture: "arm64", dependencies: { environment: { NODE_OPTIONS: "--require attacker", npm_config_registry: "https://attacker.invalid", NPM_CONFIG_CACHE: "/attacker", PATH: "/safe/bin" }, fileSystem: fs, run, randomSuffix: () => "test" } })).resolves.toEqual({ root: paths.latest, version: "1.2.3" });
    const nodeBin = path.join(nodeRoot, "bin");
    // 번들 node bin이 PATH 앞에 붙어야 npm lifecycle 스크립트가 node를 찾는다.
    expect(run).toHaveBeenCalledWith(path.join(nodeBin, "node"), [path.join(nodeRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js"), "install", "--prefix", staging, "--global=false", "--force=false", "--package-lock=false", "--no-audit", "--no-fund", "@dotobokuri/fleet-console@1.2.3"], { env: expect.objectContaining({ PATH: `${nodeBin}:/safe/bin`, npm_config_registry: "https://registry.npmjs.org/", npm_config_userconfig: path.join(staging, ".npmrc"), npm_config_globalconfig: path.join(staging, ".npmrc-global") }) });
    const firstRun = run.mock.calls[0];
    if (!firstRun) throw new Error("npm invocation was not captured");
    const runEnvironment = firstRun[2].env;
    expect(runEnvironment.NODE_OPTIONS).toBeUndefined();
    expect(runEnvironment.npm_config_registry).toBe("https://registry.npmjs.org/");
    expect(runEnvironment.NPM_CONFIG_CACHE).toBeUndefined();
    expect(runEnvironment.npm_config_userconfig).not.toBe(runEnvironment.npm_config_globalconfig);
    expect(fs.writeFile).toHaveBeenCalledWith(path.join(staging, ".npmrc"), "");
    expect(fs.writeFile).toHaveBeenCalledWith(path.join(staging, ".npmrc-global"), "");
    expect(fs.rm).toHaveBeenCalledWith(path.join(staging, ".npmrc"));
    expect(fs.rm).toHaveBeenCalledWith(path.join(staging, ".npmrc-global"));
    expect(fs.rename).toHaveBeenCalledWith(path.join(staging, "node_modules", "@dotobokuri", "fleet-console"), `${staging}.package`);
    expect(fs.stat).toHaveBeenCalledWith(path.join(staging, "dist", "cli.mjs"));
    expect(fs.stat).toHaveBeenCalledWith(path.join(staging, "node_modules", "node-pty"));
    expect(fs.writeFile).toHaveBeenCalledWith(path.join(staging, ".fleet-console-resource-root"), "1\n");
    const spawnHelper = path.join(staging, "node_modules", "node-pty", "prebuilds", "darwin-arm64", "spawn-helper");
    expect(fs.chmod).toHaveBeenCalledWith(spawnHelper, 0o755);
    expect(fs.accessExecutable).toHaveBeenCalledWith(spawnHelper);
  });

  it("rejects npm aliases, URLs, ranges, and prereleases before spawning npm", async () => {
    const fs = fileSystem();
    const run = vi.fn(async () => undefined);
    const paths = resolveRuntimePaths("/Users/fleet");
    for (const version of ["npm:attacker@1.0.0", "https://attacker.invalid/pkg.tgz", "^1.2.3", "1.2.3-beta.1"]) {
      await expect(installConsole({ paths, nodeRoot: "/runtime/node", packageName: "@dotobokuri/fleet-console", version, nodeRuntimeVersion: "22.23.1", platform: "darwin", dependencies: { fileSystem: fs, run, randomSuffix: () => "test" } })).rejects.toThrow("console_install_version_invalid");
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("fails closed when the repaired macOS spawn helper is still not executable", async () => {
    const fs = fileSystem();
    fs.accessExecutable.mockRejectedValueOnce(new Error("EACCES"));
    await expect(repairConsoleNativeExecutables("/console/latest", "darwin", "arm64", fs)).rejects.toThrow("console_install_node_pty_spawn_helper_not_executable");
  });

  it("restores the previous latest installation when promotion fails", async () => {
    const fs = fileSystem(new Set(["/console/latest", "/console/.staging"]));
    fs.rename.mockImplementation(async (from: string, to: string) => {
      if (from === "/console/.staging" && to === "/console/latest") throw new Error("rename failed");
      if (from === "/console/latest") { fs.stat.mockImplementationOnce(async () => { throw missing(); }); }
    });
    await expect(replaceLatest("/console/latest", "/console/.staging", fs)).rejects.toThrow("rename failed");
    expect(fs.rename).toHaveBeenNthCalledWith(1, "/console/latest", "/console/latest.rollback");
    expect(fs.rename).toHaveBeenNthCalledWith(2, "/console/.staging", "/console/latest");
    expect(fs.rename).toHaveBeenNthCalledWith(3, "/console/latest.rollback", "/console/latest");
  });

  it("recovers an interrupted rollback and removes abandoned staging directories", async () => {
    const paths = resolveRuntimePaths("/Users/fleet");
    const fs = fileSystem(new Set([`${paths.latest}.rollback`]));
    fs.readdir.mockResolvedValueOnce(["latest.rollback", ".staging-crashed", "keep"]);
    await reconcileConsoleInstallations(paths, fs);
    expect(fs.rename).toHaveBeenCalledWith(`${paths.latest}.rollback`, paths.latest);
    expect(fs.rm).toHaveBeenCalledWith(path.join(paths.console, ".staging-crashed"));
  });
});

describe("console installer environment PATH", () => {

  it("defaults the installer environment to trust the OS CA store (issue #531)", () => {
    const env = createConsoleInstallerEnvironment({}, "/s/.npmrc", "/s/.npmrc-global", "/runtime/node/bin", "darwin");
    expect(env.NODE_USE_SYSTEM_CA).toBe("1");
  });
});
