import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { validateDesktopResourceRoot } from "@dotobokuri/fleet-console/desktop-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { installConsole } from "../src/runtime/console-installer.js";
import { resolveDesktopResourcePaths } from "../src/resource-paths.js";
import { resolveRuntimePaths } from "../src/runtime/runtime-paths.js";

const temporaryRoots: string[] = [];

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
      version: "1.2.3",
      platform: process.platform,
      dependencies: {
        randomSuffix: () => "fixture",
        fileSystem: (await import("../src/runtime/console-installer.js")).createConsoleInstallerDependencies().fileSystem,
        run: async (_command, arguments_) => createPrefixFixture(arguments_[3]!),
      },
    });
    const pathsFromPackagedShell = resolveDesktopResourcePaths(true);
    expect(await readFile(path.join(paths.latest, ".fleet-console-resource-root"), "utf8")).toBe("1\n");
    expect(await readFile(path.join(paths.latest, "package.json"), "utf8")).toContain('"version":"1.2.3"');
    expect(pathsFromPackagedShell.cliPath.endsWith(path.join("console", "latest", "dist", "cli.mjs"))).toBe(true);
    expect(validateDesktopResourceRoot(paths.latest, paths.latest)).toBe(await realpath(paths.latest));
  });
});

async function createPrefixFixture(prefix: string): Promise<void> {
  const packageRoot = path.join(prefix, "node_modules", "@dotobokuri", "fleet-console");
  await mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await mkdir(path.join(prefix, "node_modules", "node-pty"), { recursive: true });
  await mkdir(path.join(prefix, "node_modules", "ws"), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), '{"name":"@dotobokuri/fleet-console","version":"1.2.3"}');
  await writeFile(path.join(packageRoot, "dist", "cli.mjs"), "export {};");
  await writeFile(path.join(packageRoot, "dist", "desktop-protocol.mjs"), "export {};");
}
