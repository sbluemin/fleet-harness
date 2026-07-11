import fs from "node:fs";
import path from "node:path";

import { test, expect } from "playwright/test";

const enabled = process.env.FLEET_DESKTOP_PACKAGED_E2E === "1";

test.describe("packaged shell runtime boundary", () => {
  test.skip(!enabled, "Set FLEET_DESKTOP_PACKAGED_E2E=1 with FLEET_DESKTOP_PACKAGED_RESOURCES on a native runner.");

  test("ships entry assets without an embedded Console runtime", async () => {
    const resources = process.env.FLEET_DESKTOP_PACKAGED_RESOURCES;
    test.skip(!resources, "FLEET_DESKTOP_PACKAGED_RESOURCES is required.");
    const root = resources as string;
    expect(fs.existsSync(path.join(root, "app.asar"))).toBe(true);
    expect(fs.existsSync(path.join(root, "sidecar"))).toBe(false);
    const emitted = fs.readdirSync(path.join(root, ".."), { recursive: true }).filter((entry) => typeof entry === "string");
    expect(emitted.some((entry) => /^latest.*\.yml$/i.test(path.basename(entry)) || entry.endsWith(".blockmap"))).toBe(false);
  });
});
