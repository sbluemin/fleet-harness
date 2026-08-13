import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const SESSION = read("../core/client/src/mobile/mobile-session-view.tsx");
const SHELL = read("../core/client/src/mobile/mobile-shell.tsx");
const OPERATIONS = read("../core/client/src/pages/operations.tsx");
const MOBILE_CSS = read("../core/client/src/styles/mobile.css");

/**
 * Mobile session chrome used to name the Operation and stop there, so Close existed only on
 * desktop frames and in a keyboard palette the phone does not surface. These pin leave vs close
 * as two jobs, and the two-tap coral arm that matches OperationFrame.
 */
describe("mobile session close", () => {
  it("hands the host close path into the mobile shell", () => {
    expect(OPERATIONS).toContain("onCloseOperation={handleClose}");
    expect(SHELL).toContain("readonly onCloseOperation: (operationId: string) => void;");
  });

  it("leaves the session without disposing when the platform back or a tab press fires", () => {
    const pop = SHELL.match(/const onPopState = \(\) => \{[\s\S]*?\};/)?.[0] ?? "";
    expect(pop).toContain("setSelectedOperationId(operationId)");
    expect(pop).toContain("onSelectOperation(operationId)");
    expect(pop).not.toContain("onCloseOperation");

    const tab = SHELL.match(/previousTabRef[\s\S]*?}, \[activeTab, onSelectOperation, selectedOperationId\]\)/)?.[0] ?? "";
    expect(tab).toContain("replaceOperationId(null)");
    expect(tab).toContain("onSelectOperation(null)");
    expect(tab).not.toContain("onCloseOperation");
  });

  it("disposes through the host path after leaving the session", () => {
    expect(SHELL).toContain("onCloseOperation(operationId)");
    expect(SHELL).toMatch(/const closeOperation = \(operationId: string\) => \{[\s\S]*replaceOperationId\(null\);[\s\S]*onCloseOperation\(operationId\);/);
    expect(SHELL).toContain("onClose={() => closeOperation(selectedOperation.id)}");
  });

  it("arms Close for 1.5s before disposing, with the desktop frame copy", () => {
    expect(SESSION).toContain("const CLOSE_ARM_DURATION_MS = 1500");
    expect(SESSION).toContain("if (!isCloseArmed)");
    expect(SESSION).toContain('t("canvas.frame.closeArmed")');
    expect(SESSION).toContain('t("canvas.frame.closeAria", { title })');
    expect(SESSION).toContain('t("canvas.frame.confirmCloseAria", { title })');
    expect(SESSION).not.toContain("onClose: () => {}");
  });

  it("keeps the close control at the 44px touch floor and paints the arm on coral", () => {
    expect(MOBILE_CSS).toMatch(/\.mobile-session-close \{[\s\S]{0,280}min-width: 44px;[\s\S]{0,80}min-height: 44px;/);
    expect(MOBILE_CSS).toContain("color: var(--coral-ink);");
    expect(MOBILE_CSS).toContain("animation: chip-close-arm 1.5s linear forwards;");
    expect(MOBILE_CSS).toMatch(/prefers-reduced-motion: reduce[\s\S]{0,120}\.mobile-session-close\.is-armed \{[\s\S]{0,80}animation: none;/);
  });

  it("keeps the title centered when Close arms", () => {
    expect(MOBILE_CSS).toContain("grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)");
    expect(MOBILE_CSS).toContain("grid-column: 2");
    expect(MOBILE_CSS).toContain("grid-column: 3");
    expect(SESSION).not.toContain("mobile-session-bar-slot");
  });
});
