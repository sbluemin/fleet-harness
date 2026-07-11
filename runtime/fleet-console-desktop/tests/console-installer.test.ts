import { describe, expect, it, vi } from "vitest";

import { installConsole, replaceLatest } from "../src/runtime/console-installer.js";
import { resolveRuntimePaths } from "../src/runtime/runtime-paths.js";

function fileSystem() {
  return { mkdir: vi.fn(async () => undefined), readFile: vi.fn(async () => JSON.stringify({ version: "1.2.3" })), rename: vi.fn<(from: string, to: string) => Promise<void>>(async () => undefined), rm: vi.fn(async () => undefined), stat: vi.fn(async () => undefined) };
}

describe("console installer", () => {
  it("uses bundled npm with a non-global prefix and validates before promotion", async () => {
    const fs = fileSystem();
    const run = vi.fn(async () => undefined);
    const paths = resolveRuntimePaths("/Users/fleet");
    await expect(installConsole({ paths, nodeRoot: "/runtime/node", packageName: "@dotobokuri/fleet-console", version: "1.2.3", platform: "darwin", dependencies: { fileSystem: fs, run, randomSuffix: () => "test" } })).resolves.toEqual({ root: paths.latest, version: "1.2.3" });
    expect(run).toHaveBeenCalledWith("/runtime/node/bin/node", ["/runtime/node/lib/node_modules/npm/bin/npm-cli.js", "install", "--prefix", "/Users/fleet/.fleet/desktop/runtime/console/.staging-test", "--global=false", "--force=false", "@dotobokuri/fleet-console@1.2.3"]);
    expect(fs.stat).toHaveBeenCalledWith("/Users/fleet/.fleet/desktop/runtime/console/.staging-test/node_modules/@dotobokuri/fleet-console/dist/cli.mjs");
  });

  it("drives npm through node.exe and the npm-cli.js script on Windows", async () => {
    const fs = fileSystem();
    const run = vi.fn(async () => undefined);
    const paths = resolveRuntimePaths("/Users/fleet");
    await installConsole({ paths, nodeRoot: "/runtime/node", packageName: "@dotobokuri/fleet-console", version: "1.2.3", platform: "win32", dependencies: { fileSystem: fs, run, randomSuffix: () => "test" } });
    // npm.cmd 직접 spawn은 최신 Node 보안 정책이 거부하고, bin/npm 셔뱅은 시스템 Node를 요구한다 — 번들 node로 npm-cli.js를 구동해야 한다.
    expect(run).toHaveBeenCalledWith(expect.stringContaining("node.exe"), expect.arrayContaining([expect.stringContaining("npm-cli.js")]));
  });

  it("restores the previous latest installation when atomic promotion fails", async () => {
    const fs = fileSystem();
    fs.rename.mockImplementation(async (from: string, to: string) => {
      if (from === "/console/.staging" && to === "/console/latest") throw new Error("rename failed");
    });
    await expect(replaceLatest("/console/latest", "/console/.staging", fs)).rejects.toThrow("rename failed");
    expect(fs.rename).toHaveBeenNthCalledWith(1, "/console/latest", "/console/latest.rollback");
    expect(fs.rename).toHaveBeenNthCalledWith(2, "/console/.staging", "/console/latest");
    expect(fs.rename).toHaveBeenNthCalledWith(3, "/console/latest.rollback", "/console/latest");
  });
});
