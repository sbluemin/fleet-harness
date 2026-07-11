import { describe, expect, it, vi } from "vitest";

import { configureTray } from "../src/tray.js";

describe("tray menu", () => {
  it("keeps update and diagnostics actions available after menu bar retirement", () => {
    const tray = { setContextMenu: vi.fn(), on: vi.fn() };
    const menu = { buildFromTemplate: vi.fn((_template: unknown) => "menu") };
    const show = vi.fn();
    const quit = vi.fn();
    const diagnostics = vi.fn();
    const updates = { check: vi.fn(async () => undefined), install: vi.fn(async () => undefined), availableVersion: () => "1.2.4" };

    configureTray(tray as never, menu as never, { show, quit, diagnostics, updates });

    const template = menu.buildFromTemplate.mock.calls[0]![0] as unknown as Array<{ label?: string; click?: () => void }>;
    expect(template.map((item) => item.label).filter(Boolean)).toEqual(["Show Fleet Console", "Check for Updates", "Update to 1.2.4…", "Diagnostics", "Quit"]);
    template[2]!.click?.();
    template[3]!.click?.();
    template[5]!.click?.();
    expect(updates.check).toHaveBeenCalledOnce();
    expect(updates.install).toHaveBeenCalledOnce();
    expect(diagnostics).toHaveBeenCalledOnce();
    expect(tray.setContextMenu).toHaveBeenCalledWith("menu");
    expect(tray.on).toHaveBeenCalledWith("click", show);
  });
});
