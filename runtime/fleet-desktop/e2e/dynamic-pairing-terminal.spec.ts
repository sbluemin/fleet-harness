import { chmodSync, existsSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { _electron as electron, expect, test, type ElectronApplication } from "playwright/test";

const enabled = process.env.FLEET_DESKTOP_E2E === "1";

test.describe("dynamic runtime pairing", () => {
  test.skip(!enabled, "Set FLEET_DESKTOP_E2E=1 with FLEET_DESKTOP_E2E_MAIN, FLEET_CONSOLE_NODE_PATH, and FLEET_DESKTOP_PAIRING_TARGET.");
  test.skip(process.platform !== "darwin", "[Unverified — requires macOS] This headed native-modal scenario is only exercised on the current macOS host.");

  test("selects the Desktop modal, pairs through the application menu, and performs target Terminal PTY I/O", async () => {
    const main = process.env.FLEET_DESKTOP_E2E_MAIN;
    const nodePath = process.env.FLEET_CONSOLE_NODE_PATH;
    const target = process.env.FLEET_DESKTOP_PAIRING_TARGET;
    const nodePtyHelper = process.env.FLEET_DESKTOP_E2E_NODE_PTY_HELPER;
    test.skip(!main || !nodePath || !target, "Dynamic pairing E2E inputs are required.");

    const targetOrigin = new URL(`http://${target}`).origin;
    const marker = path.join(os.tmpdir(), `fleet-terminal-e2e-${process.pid}-${Date.now()}`);
    const originalNodePtyHelperMode = nodePtyHelper ? statSync(nodePtyHelper).mode & 0o777 : undefined;
    let app: ElectronApplication | undefined;
    try {
      if (nodePtyHelper) {
        chmodSync(nodePtyHelper, 0o644);
        expect(statSync(nodePtyHelper).mode & 0o777).toBe(0o644);
      }
      app = await electron.launch({ args: [path.resolve(main)], env: { ...process.env, FLEET_CONSOLE_NODE_PATH: nodePath } });
      const window = await app.firstWindow();
      await expect(window).toHaveURL(/\/console\//);
      expect(new URL(window.url()).origin).not.toBe(targetOrigin);

      const clicked = await app.evaluate(({ Menu, BrowserWindow }) => {
        const item = Menu.getApplicationMenu()?.items
          .flatMap((entry) => entry.submenu?.items ?? [])
          .find((entry) => entry.label === "Connect to Runtime…");
        const owner = BrowserWindow.getAllWindows()[0];
        if (!item?.click || !owner) return false;
        item.click(item, owner, { triggeredByAccelerator: false });
        return true;
      });
      expect(clicked).toBe(true);
      await expect.poll(() => app!.windows().length).toBe(2);
      const pairingWindow = app.windows().find((candidate) => candidate !== window);
      expect(pairingWindow).toBeTruthy();
      const input = pairingWindow!.getByRole("textbox", { name: "Fleet Console runtime address" });
      await expect(input).toBeVisible();
      await input.fill(target);
      await pairingWindow!.getByRole("button", { name: "Connect", exact: true }).click();
      await expect(window).toHaveURL(new RegExp(`^${escapeRegExp(targetOrigin)}/console/`));
      await window.waitForTimeout(250);

      const closeSetupGuide = window.locator("button.commissioning-scrim");
      const closeWhatsNew = window.locator("button.whatsnew-scrim");
      if (await closeSetupGuide.isVisible()) await closeSetupGuide.click({ force: true, position: { x: 5, y: 5 } });
      if (await closeWhatsNew.isVisible()) await closeWhatsNew.click({ force: true, position: { x: 5, y: 5 } });
      const terminal = window.getByRole("region", { name: "Terminal" });
      for (let attempt = 0; attempt < 5 && !(await terminal.isVisible()); attempt += 1) {
        if (await closeSetupGuide.isVisible()) await closeSetupGuide.click({ force: true, position: { x: 5, y: 5 } });
        if (await closeWhatsNew.isVisible()) await closeWhatsNew.click({ force: true, position: { x: 5, y: 5 } });
        try {
          await window.getByRole("tab", { name: "Shell" }).click({ timeout: 2_000 });
        } catch {
          continue;
        }
        await window.waitForTimeout(250);
      }
      await expect(terminal).toBeVisible();
      await expect(terminal.locator(".terminal-status")).toHaveCount(0, { timeout: 15_000 });
      const terminalInput = terminal.locator(".xterm-helper-textarea");
      await expect(terminalInput).toHaveCount(1);
      await terminalInput.pressSequentially(`printf FLEET_TERMINAL_E2E_OK > ${quoteShellArgument(marker)}`);
      await terminalInput.press("Enter");
      await expect.poll(() => existsSync(marker), { timeout: 15_000 }).toBe(true);
      if (nodePtyHelper) expect(statSync(nodePtyHelper).mode & 0o111).toBe(0o111);
    } finally {
      try {
        if (app) await app.close();
      } finally {
        rmSync(marker, { force: true });
        if (nodePtyHelper && originalNodePtyHelperMode !== undefined) chmodSync(nodePtyHelper, originalNodePtyHelperMode);
      }
    }
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
