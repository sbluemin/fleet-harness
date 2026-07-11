import { describe, expect, it, vi } from "vitest";

import { installApplicationMenu } from "../src/menu.js";

describe("application menu", () => {
  it("keeps the macOS application and edit menus with all desktop actions", () => {
    const menu = { buildFromTemplate: vi.fn((_template: unknown) => "menu"), setApplicationMenu: vi.fn() };
    const updates = { check: vi.fn(async () => undefined), install: vi.fn(async () => undefined) };

    installApplicationMenu(menu as never, { show: vi.fn(), quit: vi.fn(), diagnostics: vi.fn(), updates }, "darwin");

    const template = menu.buildFromTemplate.mock.calls[0]![0] as unknown as Array<{ role?: string; submenu?: Array<{ label?: string; role?: string }> }>;
    expect(template.map((item) => item.role)).toEqual(["appMenu", "editMenu"]);
    expect(template[0]!.submenu?.map((item) => item.label ?? item.role)).toEqual(["Show", undefined, "Check for Updates", "Update and Restart", undefined, "Diagnostics", "quit"]);
    expect(menu.setApplicationMenu).toHaveBeenCalledWith("menu");
  });

  it.each(["win32", "linux"] as const)("removes the native menu bar on %s", (platform) => {
    const menu = { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() };
    const updates = { check: vi.fn(async () => undefined), install: vi.fn(async () => undefined) };

    installApplicationMenu(menu as never, { show: vi.fn(), quit: vi.fn(), diagnostics: vi.fn(), updates }, platform);

    expect(menu.buildFromTemplate).not.toHaveBeenCalled();
    expect(menu.setApplicationMenu).toHaveBeenCalledWith(null);
  });
});
