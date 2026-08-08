import { describe, expect, it, vi } from "vitest";

import { configureTray, createDesktopTray, shouldConfigureTray } from "../src/tray.js";

describe("desktop tray creation", () => {
  it("uses the template icon and only attaches the show click handler on macOS", () => {
    const tray = { on: vi.fn() };
    const TrayCtor = vi.fn(function () { return tray; });
    const show = vi.fn();
    const actions = { show } as unknown as Parameters<typeof createDesktopTray>[3];
    const resources = { iconPath: "/build/icon.png", trayTemplateIconPath: "/build/trayTemplate.png" } as Parameters<typeof createDesktopTray>[2];

    expect(createDesktopTray("darwin", TrayCtor as never, resources, actions)).toBe(tray);
    expect(TrayCtor).toHaveBeenCalledWith("/build/trayTemplate.png");
    expect(tray.on).toHaveBeenCalledWith("click", show);
  });

  it("keeps the color icon and click handler on Windows and Linux", () => {
    for (const platform of ["win32", "linux"] as const) {
      const tray = { on: vi.fn() };
      const TrayCtor = vi.fn(function () { return tray; });
      const show = vi.fn();
      const actions = { show } as unknown as Parameters<typeof createDesktopTray>[3];
      const resources = { iconPath: "/build/icon.png", trayTemplateIconPath: "/build/trayTemplate.png" } as Parameters<typeof createDesktopTray>[2];

      createDesktopTray(platform, TrayCtor as never, resources, actions);
      expect(TrayCtor).toHaveBeenCalledWith("/build/icon.png");
      expect(tray.on).toHaveBeenCalledWith("click", show);
    }
  });

  it("never configures a context menu on macOS", () => {
    expect(shouldConfigureTray("darwin")).toBe(false);
    expect(shouldConfigureTray("win32")).toBe(true);
    expect(shouldConfigureTray("linux")).toBe(true);
  });
});

describe("tray menu", () => {
  it("places gated Console actions directly below Show without moving update, diagnostics, or quit", () => {
    const tray = { setContextMenu: vi.fn(), on: vi.fn() };
    const menu = { buildFromTemplate: vi.fn((_template: unknown) => "menu") };
    const show = vi.fn();
    const quit = vi.fn();
    const diagnostics = vi.fn();
    const zoomIn = vi.fn();
    const zoomOut = vi.fn();
    const actualSize = vi.fn();
    const reloadConsole = vi.fn();
    let consoleReady = false;
    const updates = { check: vi.fn(async () => undefined), install: vi.fn(async () => undefined), availableVersion: () => "1.2.4", enabled: () => true };

    configureTray(tray as never, menu as never, { show, quit, diagnostics, zoomIn, zoomOut, actualSize, reloadConsole, consoleReady: () => consoleReady, updates });

    const template = menu.buildFromTemplate.mock.calls[0]![0] as unknown as Array<{ label?: string; accelerator?: string; enabled?: boolean; click?: () => void }>;
    // 다른 콘솔로 건너가는 동선은 Console 안에 있다 — 트레이는 그 일을 두 번째 자리에서 제공하지 않는다.
    expect(template.map((item) => item.label).filter(Boolean)).toEqual(["Show Fleet Console", "Zoom In", "Zoom Out", "Actual Size", "Reload Console", "Check for Updates", "Update to 1.2.4\u2026", "Diagnostics", "Quit"]);
    expect(template.slice(2, 6).map((item) => item.accelerator)).toEqual(["Ctrl+=", "Ctrl+-", "Ctrl+0", "Ctrl+R"]);
    expect(template.slice(2, 6).every((item) => item.enabled === false)).toBe(true);
    template[5]!.click?.();
    expect(reloadConsole).not.toHaveBeenCalled();

    consoleReady = true;
    configureTray(tray as never, menu as never, { show, quit, diagnostics, zoomIn, zoomOut, actualSize, reloadConsole, consoleReady: () => consoleReady, updates });
    const enabledTemplate = menu.buildFromTemplate.mock.calls[1]![0] as typeof template;
    expect(enabledTemplate.slice(2, 6).every((item) => item.enabled === true)).toBe(true);
    enabledTemplate[2]!.click?.();
    enabledTemplate[3]!.click?.();
    enabledTemplate[4]!.click?.();
    enabledTemplate[5]!.click?.();
    enabledTemplate[7]!.click?.();
    enabledTemplate[8]!.click?.();
    enabledTemplate[10]!.click?.();
    expect(zoomIn).toHaveBeenCalledOnce();
    expect(zoomOut).toHaveBeenCalledOnce();
    expect(actualSize).toHaveBeenCalledOnce();
    expect(reloadConsole).toHaveBeenCalledOnce();
    expect(updates.check).toHaveBeenCalledOnce();
    expect(updates.install).toHaveBeenCalledOnce();
    expect(diagnostics).toHaveBeenCalledOnce();
    expect(tray.setContextMenu).toHaveBeenCalledWith("menu");
    expect(tray.on).not.toHaveBeenCalled();
  });
});
