import { describe, expect, it, vi } from "vitest";

import { installApplicationMenu } from "../src/menu.js";

describe("application menu", () => {
  it("keeps the macOS application and edit menus while adding gated View actions and every accelerator", () => {
    const menu = { buildFromTemplate: vi.fn((_template: unknown) => "menu"), setApplicationMenu: vi.fn() };
    const updates = { check: vi.fn(async () => undefined), install: vi.fn(async () => undefined), availableVersion: () => "1.2.4", enabled: () => true };
    let consoleReady = false;
    const zoomIn = vi.fn();
    const zoomOut = vi.fn();
    const actualSize = vi.fn();
    const reloadConsole = vi.fn();
    const connectRuntime = vi.fn();

    installApplicationMenu(menu as never, { show: vi.fn(), quit: vi.fn(), diagnostics: vi.fn(), zoomIn, zoomOut, actualSize, reloadConsole, connectRuntime, consoleReady: () => consoleReady, updates }, "darwin");

    const template = menu.buildFromTemplate.mock.calls[0]![0] as unknown as Array<{ label?: string; role?: string; submenu?: Array<{ label?: string; role?: string; accelerator?: string; enabled?: boolean; visible?: boolean; click?: () => void }> }>;
    expect(template.map((item) => item.role ?? item.label)).toEqual(["appMenu", "editMenu", "View"]);
    expect(template[0]!.submenu?.map((item) => item.label ?? item.role)).toEqual(["Show", "Connect to Runtime…", undefined, "Check for Updates", "Update to 1.2.4…", undefined, "Diagnostics", "quit"]);
    template[0]!.submenu?.[1]?.click?.();
    expect(template[0]!.submenu?.[1]?.enabled).toBe(false);
    expect(connectRuntime).not.toHaveBeenCalled();
    const view = template[2]!.submenu!;
    expect(view.filter((item) => item.accelerator).map((item) => item.accelerator)).toEqual(["Command+R", "Command+Plus", "Command+=", "Command+numadd", "Command+-", "Command+numsub", "Command+0"]);
    expect(view.filter((item) => item.accelerator).every((item) => item.enabled === false)).toBe(true);
    expect(view.filter((item) => item.visible === false).map((item) => item.accelerator)).toEqual(["Command+=", "Command+numadd", "Command+numsub"]);
    view[0]!.click?.();
    expect(reloadConsole).not.toHaveBeenCalled();

    consoleReady = true;
    installApplicationMenu(menu as never, { show: vi.fn(), quit: vi.fn(), diagnostics: vi.fn(), zoomIn, zoomOut, actualSize, reloadConsole, connectRuntime, consoleReady: () => consoleReady, updates }, "darwin");
    const enabledView = (menu.buildFromTemplate.mock.calls[1]![0] as typeof template)[2]!.submenu!;
    const enabledApp = (menu.buildFromTemplate.mock.calls[1]![0] as typeof template)[0]!.submenu!;
    expect(enabledApp[1]?.enabled).toBe(true);
    enabledApp[1]?.click?.();
    expect(connectRuntime).toHaveBeenCalledOnce();
    expect(enabledView.filter((item) => item.accelerator).every((item) => item.enabled === true)).toBe(true);
    enabledView[0]!.click?.();
    enabledView[2]!.click?.();
    enabledView[5]!.click?.();
    enabledView[7]!.click?.();
    expect(reloadConsole).toHaveBeenCalledOnce();
    expect(zoomIn).toHaveBeenCalledOnce();
    expect(zoomOut).toHaveBeenCalledOnce();
    expect(actualSize).toHaveBeenCalledOnce();
    expect(menu.setApplicationMenu).toHaveBeenCalledWith("menu");
  });

  it.each(["win32", "linux"] as const)("installs hidden accelerators and permanently hides the native menu bar on %s", (platform) => {
    const menu = { buildFromTemplate: vi.fn((_template: unknown) => "menu"), setApplicationMenu: vi.fn() };
    const updates = { check: vi.fn(async () => undefined), install: vi.fn(async () => undefined), availableVersion: () => null, enabled: () => true };
    const window = { setMenu: vi.fn(), setMenuBarVisibility: vi.fn() };
    const zoomIn = vi.fn();
    const zoomOut = vi.fn();
    const actualSize = vi.fn();
    const reloadConsole = vi.fn();
    const connectRuntime = vi.fn();
    let consoleReady = false;

    installApplicationMenu(menu as never, { show: vi.fn(), quit: vi.fn(), diagnostics: vi.fn(), zoomIn, zoomOut, actualSize, reloadConsole, connectRuntime, consoleReady: () => consoleReady, updates }, platform, window as never);

    const template = menu.buildFromTemplate.mock.calls[0]![0] as Array<{ submenu: Array<{ accelerator?: string; enabled?: boolean; click?: () => void }> }>;
    const hiddenActions = template[0]!.submenu.filter((item) => item.accelerator);
    expect(hiddenActions.map((item) => item.accelerator)).toEqual(["Ctrl+R", "F5", "Ctrl+=", "Ctrl+Shift+=", "Ctrl+numadd", "Ctrl+-", "Ctrl+numsub", "Ctrl+0"]);
    expect(hiddenActions.every((item) => item.enabled === false)).toBe(true);
    hiddenActions[0]!.click?.();
    expect(reloadConsole).not.toHaveBeenCalled();
    expect(window.setMenu).toHaveBeenCalledWith("menu");
    expect(window.setMenuBarVisibility).toHaveBeenCalledWith(false);

    consoleReady = true;
    installApplicationMenu(menu as never, { show: vi.fn(), quit: vi.fn(), diagnostics: vi.fn(), zoomIn, zoomOut, actualSize, reloadConsole, connectRuntime, consoleReady: () => consoleReady, updates }, platform, window as never);
    const enabledActions = ((menu.buildFromTemplate.mock.calls[1]![0] as typeof template)[0]!.submenu.filter((item) => item.accelerator));
    expect(enabledActions.every((item) => item.enabled === true)).toBe(true);
    enabledActions[0]!.click?.();
    enabledActions[2]!.click?.();
    enabledActions[5]!.click?.();
    enabledActions[7]!.click?.();
    expect(reloadConsole).toHaveBeenCalledOnce();
    expect(zoomIn).toHaveBeenCalledOnce();
    expect(zoomOut).toHaveBeenCalledOnce();
    expect(actualSize).toHaveBeenCalledOnce();
  });
});
