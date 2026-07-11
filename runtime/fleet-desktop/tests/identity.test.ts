import { describe, expect, it, vi } from "vitest";

import { applyDesktopDockIcon, applyDesktopIdentity, DESKTOP_APP_USER_MODEL_ID, DESKTOP_PRODUCT_NAME } from "../src/identity.js";

describe("desktop identity", () => {
  it("sets the Fleet Console name without calling the macOS Dock before ready", () => {
    const setName = vi.fn();
    const setIcon = vi.fn();

    applyDesktopIdentity({ setName, dock: { setIcon } }, "darwin");

    expect(setName).toHaveBeenCalledWith(DESKTOP_PRODUCT_NAME);
    expect(setIcon).not.toHaveBeenCalled();
  });

  it("sets the Windows application identity without a Dock call", () => {
    const setName = vi.fn();
    const setAppUserModelId = vi.fn();

    applyDesktopIdentity({ setName, setAppUserModelId }, "win32");

    expect(setName).toHaveBeenCalledWith(DESKTOP_PRODUCT_NAME);
    expect(setAppUserModelId).toHaveBeenCalledWith(DESKTOP_APP_USER_MODEL_ID);
  });

  it("applies the native macOS Dock icon only from the ready lifecycle", () => {
    const setIcon = vi.fn();

    applyDesktopDockIcon({ setName: vi.fn(), dock: { setIcon } }, "/assets/icon.png", "darwin");
    applyDesktopDockIcon({ setName: vi.fn(), dock: { setIcon } }, "/assets/icon.png", "win32");

    expect(setIcon).toHaveBeenCalledOnce();
    expect(setIcon).toHaveBeenCalledWith("/assets/icon.png");
  });
});
