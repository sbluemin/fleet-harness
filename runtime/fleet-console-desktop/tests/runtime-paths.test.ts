import { describe, expect, it } from "vitest";

import { createStagingPath, readRuntimePresence, resolveRuntimePaths } from "../src/runtime/runtime-paths.js";

describe("desktop runtime paths", () => {
  it("separates desktop runtime code from Console data", async () => {
    const paths = resolveRuntimePaths("/Users/fleet");
    expect(paths).toMatchObject({ root: "/Users/fleet/.fleet/desktop/runtime", node: "/Users/fleet/.fleet/desktop/runtime/node", latest: "/Users/fleet/.fleet/desktop/runtime/console/latest" });
    expect(createStagingPath(paths, "random")).toBe("/Users/fleet/.fleet/desktop/runtime/console/.staging-random");
    await expect(readRuntimePresence(paths, { access: async (target) => { if (target !== paths.node) throw new Error("missing"); } })).resolves.toEqual({ node: true, latest: false });
  });

  it("rejects a staging suffix that can escape the console root", () => {
    expect(() => createStagingPath(resolveRuntimePaths("/Users/fleet"), "../escape")).toThrow("runtime_staging_suffix_invalid");
  });
});
