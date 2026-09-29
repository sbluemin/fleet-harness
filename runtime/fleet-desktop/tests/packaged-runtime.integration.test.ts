import { copyFile, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { installConsole } from "../src/runtime/console-installer.js";
import { resolveDesktopResourcePaths } from "../src/resource-paths.js";
import { resolveRuntimePaths } from "../src/runtime/runtime-paths.js";

const temporaryRoots: string[] = [];
const requireFromTest = createRequire(import.meta.url);
const compiledDesktopProtocol = requireFromTest.resolve("@dotobokuri/fleet-console/desktop-protocol");

afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))); });

describe("packaged runtime fixture", () => {
  it("promotes an actual npm-prefix fixture into a desktop-protocol-valid latest package root", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fleet-desktop-runtime-"));
    temporaryRoots.push(home);
    const paths = resolveRuntimePaths(home);
    await installConsole({
      paths,
      nodeRoot: path.join(home, "node"),
      packageName: "@dotobokuri/fleet-console",
      release: { schema: 1, package: "@dotobokuri/fleet-console", version: "1.2.3", tag: "v1.2.3", tarball: { name: "fleet-console-1.2.3.tgz", size: 1, sha256: "0".repeat(64) } },
      nodeRuntimeVersion: "22.23.1",
      platform: process.platform,
      dependencies: {
        randomSuffix: () => "fixture",
        fileSystem: (await import("../src/runtime/console-installer.js")).createConsoleInstallerDependencies().fileSystem,
        downloadTarball: async (_release, directory) => {
          await mkdir(directory, { recursive: true });
          await writeFile(path.join(directory, "fleet-console-1.2.3.tgz"), "fixture");
          return path.join(directory, "fleet-console-1.2.3.tgz");
        },
        run: async (_command, arguments_) => createPrefixFixture(arguments_[3]!),
      },
    });
    const pathsFromPackagedShell = resolveDesktopResourcePaths(true);
    expect(await readFile(path.join(paths.latest, ".fleet-console-resource-root"), "utf8")).toBe("1\n");
    expect(await readFile(path.join(paths.latest, "package.json"), "utf8")).toContain('"version":"1.2.3"');
    // 내려받은 tarball은 latest로 승격되지 않고 설치가 끝나면 사라진다.
    await expect(readFile(path.join(paths.console, ".staging-fixture.download", "fleet-console-1.2.3.tgz"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(pathsFromPackagedShell.cliPath.endsWith(path.join("console", "latest", "dist", "cli.mjs"))).toBe(true);
    const protocol = await import(pathToFileURL(path.join(paths.latest, "dist", "desktop-protocol.mjs")).href);
    expect(protocol.validateDesktopResourceRoot(paths.latest)).toBe(await realpath(paths.latest));
  });
});

async function createPrefixFixture(prefix: string): Promise<void> {
  const packageRoot = path.join(prefix, "node_modules", "@dotobokuri", "fleet-console");
  await mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await mkdir(path.join(prefix, "node_modules", "node-pty"), { recursive: true });
  const prebuildDirectory = path.join(prefix, "node_modules", "node-pty", "prebuilds", `darwin-${process.arch}`);
  if (process.platform === "darwin") {
    await mkdir(prebuildDirectory, { recursive: true });
    await writeFile(path.join(prebuildDirectory, "spawn-helper"), "fixture", { mode: 0o644 });
  }
  await mkdir(path.join(prefix, "node_modules", "ws"), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), '{"name":"@dotobokuri/fleet-console","version":"1.2.3"}');
  await writeFile(path.join(packageRoot, "dist", "cli.mjs"), "export {};");
  await copyFile(compiledDesktopProtocol, path.join(packageRoot, "dist", "desktop-protocol.mjs"));
}
