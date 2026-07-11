import fs from "node:fs";
import path from "node:path";

import { test, expect } from "playwright/test";
const enabled = process.env.FLEET_DESKTOP_PACKAGED_E2E === "1";

test.describe("packaged sidecar boundary", () => {
  test.skip(!enabled, "Set FLEET_DESKTOP_PACKAGED_E2E=1 on a native staged/package runner.");

  test("keeps Node, Console, REST, and SSE resources outside asar", async () => {
    const resources = process.env.FLEET_DESKTOP_PACKAGED_RESOURCES;
    expect(resources, "native packaged resource root is required").toBeTruthy();
    const root = resources as string;
    expect(fs.existsSync(path.join(root, "app.asar"))).toBe(true);
    expect(fs.existsSync(path.join(root, "sidecar", "fleet-console", "dist", "cli.mjs"))).toBe(true);
    expect(fs.existsSync(path.join(root, "sidecar", "node", process.platform === "win32" ? "node.exe" : "bin/node"))).toBe(true);
    expect(path.join(root, "sidecar")).not.toContain("app.asar");
  });
});
