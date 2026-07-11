import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createConsoleInstallerEnvironment, installConsole, reconcileConsoleInstallations, replaceLatest } from "../src/runtime/console-installer.js";
import { resolveRuntimePaths } from "../src/runtime/runtime-paths.js";

function missing(): NodeJS.ErrnoException { const error = new Error("missing") as NodeJS.ErrnoException; error.code = "ENOENT"; return error; }

function fileSystem(existing = new Set<string>()) {
  const stat = vi.fn(async (target: string) => { if (!existing.has(target) && !target.includes(".staging-test/")) throw missing(); });
  const rename = vi.fn(async (from: string, to: string) => { if (!existing.has(from) && !from.includes(".staging-test") && !from.endsWith(".package")) throw missing(); existing.delete(from); existing.add(to); });
  return {
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
    await expect(installConsole({ paths, nodeRoot: "/runtime/node", packageName: "@dotobokuri/fleet-console", version: "1.2.3", nodeRuntimeVersion: "22.23.1", platform: "darwin", dependencies: { environment: { NODE_OPTIONS: "--require attacker", npm_config_registry: "https://attacker.invalid", NPM_CONFIG_CACHE: "/attacker", PATH: "/safe/bin" }, fileSystem: fs, run, randomSuffix: () => "test" } })).resolves.toEqual({ root: paths.latest, version: "1.2.3" });
    // 번들 node bin("/runtime/node/bin")이 PATH 앞에 붙어야 npm lifecycle 스크립트가 node를 찾는다.
    expect(run).toHaveBeenCalledWith("/runtime/node/bin/node", ["/runtime/node/lib/node_modules/npm/bin/npm-cli.js", "install", "--prefix", "/Users/fleet/.fleet/desktop/runtime/console/.staging-test", "--global=false", "--force=false", "--package-lock=false", "--no-audit", "--no-fund", "@dotobokuri/fleet-console@1.2.3"], { env: expect.objectContaining({ PATH: "/runtime/node/bin:/safe/bin", npm_config_registry: "https://registry.npmjs.org/", npm_config_userconfig: "/Users/fleet/.fleet/desktop/runtime/console/.staging-test/.npmrc", npm_config_globalconfig: "/Users/fleet/.fleet/desktop/runtime/console/.staging-test/.npmrc-global" }) });
    const firstRun = run.mock.calls[0];
    if (!firstRun) throw new Error("npm invocation was not captured");
    const runEnvironment = firstRun[2].env;
    expect(runEnvironment.NODE_OPTIONS).toBeUndefined();
    expect(runEnvironment.npm_config_registry).toBe("https://registry.npmjs.org/");
    expect(runEnvironment.NPM_CONFIG_CACHE).toBeUndefined();
    expect(runEnvironment.npm_config_userconfig).not.toBe(runEnvironment.npm_config_globalconfig);
    expect(fs.writeFile).toHaveBeenCalledWith("/Users/fleet/.fleet/desktop/runtime/console/.staging-test/.npmrc", "");
    expect(fs.writeFile).toHaveBeenCalledWith("/Users/fleet/.fleet/desktop/runtime/console/.staging-test/.npmrc-global", "");
    expect(fs.rm).toHaveBeenCalledWith("/Users/fleet/.fleet/desktop/runtime/console/.staging-test/.npmrc");
    expect(fs.rm).toHaveBeenCalledWith("/Users/fleet/.fleet/desktop/runtime/console/.staging-test/.npmrc-global");
    expect(fs.rename).toHaveBeenCalledWith("/Users/fleet/.fleet/desktop/runtime/console/.staging-test/node_modules/@dotobokuri/fleet-console", "/Users/fleet/.fleet/desktop/runtime/console/.staging-test.package");
    expect(fs.stat).toHaveBeenCalledWith("/Users/fleet/.fleet/desktop/runtime/console/.staging-test/dist/cli.mjs");
    expect(fs.stat).toHaveBeenCalledWith("/Users/fleet/.fleet/desktop/runtime/console/.staging-test/node_modules/node-pty");
    expect(fs.writeFile).toHaveBeenCalledWith("/Users/fleet/.fleet/desktop/runtime/console/.staging-test/.fleet-console-resource-root", "1\n");
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

  it("drives npm through node.exe and the npm-cli.js script on Windows", async () => {
    const fs = fileSystem();
    const run = vi.fn<(command: string, arguments_: readonly string[], options: { readonly env: NodeJS.ProcessEnv }) => Promise<void>>(async () => undefined);
    const paths = resolveRuntimePaths("/Users/fleet");
    await installConsole({ paths, nodeRoot: "/runtime/node", packageName: "@dotobokuri/fleet-console", version: "1.2.3", nodeRuntimeVersion: "22.23.1", platform: "win32", dependencies: { fileSystem: fs, run, randomSuffix: () => "test" } });
    expect(run).toHaveBeenCalledWith(expect.stringContaining("node.exe"), expect.arrayContaining([expect.stringContaining("npm-cli.js")]), { env: expect.objectContaining({ npm_config_registry: "https://registry.npmjs.org/" }) });
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
    expect(fs.rm).toHaveBeenCalledWith(`${paths.console}/.staging-crashed`);
  });

  it("keeps promoted latest when rollback cleanup fails so the next start can reconcile it", async () => {
    const fs = fileSystem(new Set(["/console/latest", "/console/.staging"]));
    fs.rm.mockImplementation(async (target: string) => { if (target === "/console/latest.rollback") throw new Error("cleanup failed"); });
    await expect(replaceLatest("/console/latest", "/console/.staging", fs)).resolves.toBeUndefined();
    expect(fs.rename).toHaveBeenCalledWith("/console/.staging", "/console/latest");
  });

  it("keeps the existing latest when the staged Console requires a newer Node", async () => {
    const paths = resolveRuntimePaths("/Users/fleet");
    const fs = fileSystem(new Set([paths.latest]));
    fs.readFile.mockImplementation(async (target: string) => target.endsWith("package.json") ? JSON.stringify({ version: "1.2.3", engines: { node: ">=23.0.0" } }) : "1\n");
    await expect(installConsole({ paths, nodeRoot: "/runtime/node", packageName: "@dotobokuri/fleet-console", version: "1.2.3", nodeRuntimeVersion: "22.23.1", platform: "darwin", dependencies: { fileSystem: fs, run: vi.fn(async () => undefined), randomSuffix: () => "test" } })).rejects.toThrow("console_install_node_engine_incompatible");
    expect(fs.rename).not.toHaveBeenCalledWith(expect.stringContaining(".staging-test"), paths.latest);
    expect(fs.rm).toHaveBeenCalledWith(path.join(paths.console, ".staging-test"));
  });

  it("continues with valid latest when re-entry cleanup cannot remove rollback or stale staging", async () => {
    const paths = resolveRuntimePaths("/Users/fleet");
    const fs = fileSystem(new Set([paths.latest, `${paths.latest}.rollback`]));
    fs.readdir.mockResolvedValueOnce(["latest.rollback", ".staging-locked"]);
    fs.rm.mockRejectedValue(new Error("locked"));
    await expect(reconcileConsoleInstallations(paths, fs)).resolves.toBeUndefined();
  });
});

describe("console installer environment PATH", () => {
  it("prepends the bundled node bin to PATH so npm lifecycle scripts resolve node (POSIX)", () => {
    const env = createConsoleInstallerEnvironment({ PATH: "/safe/bin" }, "/s/.npmrc", "/s/.npmrc-global", "/runtime/node/bin", "darwin");
    expect(env.PATH).toBe("/runtime/node/bin:/safe/bin");
  });

  it("sets PATH to the bundled node bin when the source has no PATH (POSIX)", () => {
    const env = createConsoleInstallerEnvironment({}, "/s/.npmrc", "/s/.npmrc-global", "/runtime/node/bin", "darwin");
    expect(env.PATH).toBe("/runtime/node/bin");
  });

  it("prepends onto the case-preserved Path key with the Windows separator", () => {
    const env = createConsoleInstallerEnvironment({ Path: "C:\\safe" }, "S:\\.npmrc", "S:\\.npmrc-global", "C:\\runtime\\node", "win32");
    expect(env.Path).toBe("C:\\runtime\\node;C:\\safe");
    expect(env.PATH).toBeUndefined();
  });

  it("leaves PATH untouched when no node bin directory is provided", () => {
    const env = createConsoleInstallerEnvironment({ PATH: "/safe/bin" }, "/s/.npmrc", "/s/.npmrc-global");
    expect(env.PATH).toBe("/safe/bin");
  });

  it("does not treat a lowercase 'path' as PATH on POSIX (case-sensitive env)", () => {
    const env = createConsoleInstallerEnvironment({ path: "/not-the-path" }, "/s/.npmrc", "/s/.npmrc-global", "/runtime/node/bin", "darwin");
    expect(env.path).toBe("/not-the-path");
    expect(env.PATH).toBe("/runtime/node/bin");
  });
});
