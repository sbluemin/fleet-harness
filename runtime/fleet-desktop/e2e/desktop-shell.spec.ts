import path from "node:path";

import { _electron as electron, test, expect } from "playwright/test";

const enabled = process.env.FLEET_DESKTOP_E2E === "1";

test.describe("unpackaged desktop shell", () => {
  test.skip(!enabled, "Set FLEET_DESKTOP_E2E=1 with FLEET_DESKTOP_E2E_MAIN and FLEET_CONSOLE_NODE_PATH.");

  test("shows the passive entry before the local Console handoff", async () => {
    const main = process.env.FLEET_DESKTOP_E2E_MAIN;
    const nodePath = process.env.FLEET_CONSOLE_NODE_PATH;
    test.skip(!main || !nodePath, "FLEET_DESKTOP_E2E_MAIN and FLEET_CONSOLE_NODE_PATH are required.");
    const app = await electron.launch({ args: [path.resolve(main)], env: { ...process.env, FLEET_CONSOLE_NODE_PATH: nodePath } });
    try {
      const window = await app.firstWindow();
      await expect(window.getByText("Fleet Console")).toBeVisible();
      await expect(window).toHaveURL(/\/console\//);
      expect(new URL(window.url()).search).toBe("");
    } finally {
      await app.close();
    }
  });
});
