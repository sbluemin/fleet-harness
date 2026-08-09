import path from "node:path";

import { describe, expect, it } from "vitest";

import { createStagingPath, readRuntimePresence, resolveRuntimePaths } from "../src/runtime/runtime-paths.js";

describe("desktop runtime paths", () => {
  it("separates desktop runtime code from Console data", async () => {
    const home = path.resolve("/Users/fleet");
    const root = path.join(home, ".fleet", "desktop", "runtime");
    const console = path.join(root, "console");
    const paths = resolveRuntimePaths(home);
    expect(paths).toMatchObject({ root, node: path.join(root, "node"), latest: path.join(console, "latest") });
    expect(createStagingPath(paths, "random")).toBe(path.join(console, ".staging-random"));
    await expect(readRuntimePresence(paths, { access: async (target) => { if (target !== paths.node) throw new Error("missing"); } })).resolves.toEqual({ node: true, latest: false });
  });

  it("rejects a staging suffix that can escape the console root", () => {
    expect(() => createStagingPath(resolveRuntimePaths("/Users/fleet"), "../escape")).toThrow("runtime_staging_suffix_invalid");
  });
});
