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
      await expect(window).toHaveURL(/\/console\//);
      expect(new URL(window.url()).search).toBe("");

      const handoffUrl = window.url();
      const history = await app.evaluate(({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0]?.webContents;
        if (!contents) throw new Error("desktop_window_unavailable");
        return {
          activeIndex: contents.navigationHistory.getActiveIndex(),
          canGoBack: contents.navigationHistory.canGoBack(),
          entries: contents.navigationHistory.getAllEntries().map(({ url }) => url),
        };
      });
      expect(history).toEqual({ activeIndex: 0, canGoBack: false, entries: [handoffUrl] });

      await window.evaluate(() => history.back());
      await window.waitForTimeout(250);
      expect(window.url()).toBe(handoffUrl);
      await expect(window.locator(".entry-body")).toHaveCount(0);

      expect(await window.goBack({ waitUntil: "domcontentloaded" })).toBeNull();
      expect(window.url()).toBe(handoffUrl);
      await expect(window.locator(".entry-body")).toHaveCount(0);

      const mainProcessBack = await app.evaluate(({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0]?.webContents;
        if (!contents) throw new Error("desktop_window_unavailable");
        const canGoBack = contents.navigationHistory.canGoBack();
        if (canGoBack) contents.navigationHistory.goBack();
        return canGoBack;
      });
      expect(mainProcessBack).toBe(false);
      await window.waitForTimeout(250);
      expect(window.url()).toBe(handoffUrl);
      await expect(window.locator(".entry-body")).toHaveCount(0);

      await window.evaluate(() => history.pushState({}, "", "/console/history-probe"));
      expect(new URL(window.url()).pathname).toBe("/console/history-probe");
      await window.goBack();
      expect(window.url()).toBe(handoffUrl);
      await expect(window.locator(".entry-body")).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test("hands HTTP links to the external browser broker", async () => {
    const main = process.env.FLEET_DESKTOP_E2E_MAIN;
    const nodePath = process.env.FLEET_CONSOLE_NODE_PATH;
    test.skip(!main || !nodePath, "FLEET_DESKTOP_E2E_MAIN and FLEET_CONSOLE_NODE_PATH are required.");
    const app = await electron.launch({ args: [path.resolve(main)], env: { ...process.env, FLEET_CONSOLE_NODE_PATH: nodePath } });
    try {
      const window = await app.firstWindow();
      await expect(window).toHaveURL(/\/console\//);
      await app.evaluate(({ shell }) => {
        const probe = globalThis as typeof globalThis & { __fleetOpenExternalUrls?: string[] };
        probe.__fleetOpenExternalUrls = [];
        shell.openExternal = async (url) => { probe.__fleetOpenExternalUrls?.push(url); };
      });

      await window.evaluate(() => {
        window.open("http://127.0.0.1:4173/preview", "_blank");
        window.open("https://fleet.example/docs", "_blank");
        window.open("file:///tmp/secret", "_blank");
      });

      await expect.poll(() => app.evaluate(() => {
        const probe = globalThis as typeof globalThis & { __fleetOpenExternalUrls?: string[] };
        return probe.__fleetOpenExternalUrls ?? [];
      })).toEqual(["http://127.0.0.1:4173/preview", "https://fleet.example/docs"]);
      expect(new URL(window.url()).pathname).toMatch(/^\/console\//);
    } finally {
      await app.close();
    }
  });
});
