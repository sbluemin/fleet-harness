import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { _electron as electron, test, expect } from "playwright/test";

const enabled = process.env.FLEET_DESKTOP_E2E === "1";

test.describe("unpackaged desktop shell", () => {
  test.skip(!enabled, "Set FLEET_DESKTOP_E2E=1 after staging an isolated sidecar fixture.");

  test("uses a fresh Console data root and exposes the token-free Console route", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desktop-e2e-"));
    const app = await electron.launch({ args: [path.resolve("dist/main.mjs")], env: { ...process.env, FLEET_CONSOLE_DIR: path.join(root, "console"), ELECTRON_USER_DATA_DIR: path.join(root, "electron") } });
    try {
      const window = await app.firstWindow();
      await expect(window.locator(".console-shell")).toBeVisible();
      await expect(window).toHaveURL(/\/console\/operations$/);
      expect(new URL(window.url()).search).toBe("");
    } finally {
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
