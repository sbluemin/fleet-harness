import { describe, expect, it, vi } from "vitest";

import { createDesktopNotifier } from "../src/desktop-notices.js";

describe("pairing notifications", () => {
  it("uses Electron Notification when supported", () => {
    const show = vi.fn();
    class NotificationMock { static isSupported(): boolean { return true; } show = (): void => { show(); }; }
    const dialog = { showMessageBox: vi.fn(async () => undefined) };
    createDesktopNotifier(NotificationMock, dialog).show({ type: "info", title: "Connected", body: "Ready" });
    expect(show).toHaveBeenCalledOnce();
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it("always shows errors in a dialog even when Electron Notification is supported", async () => {
    const show = vi.fn();
    class NotificationMock { static isSupported(): boolean { return true; } show = (): void => { show(); }; }
    const dialog = { showMessageBox: vi.fn(async () => undefined) };
    createDesktopNotifier(NotificationMock, dialog).show({ type: "error", title: "Failed", body: "Still connected" });
    await vi.waitFor(() => expect(dialog.showMessageBox).toHaveBeenCalledWith({ type: "error", title: "Failed", message: "Still connected", buttons: ["OK"] }));
    expect(show).not.toHaveBeenCalled();
  });

  it("shows a visible native dialog fallback when Electron Notification is unavailable", async () => {
    const dialog = { showMessageBox: vi.fn(async () => undefined) };
    createDesktopNotifier({ isSupported: () => false } as never, dialog).show({ type: "error", title: "Failed", body: "Still connected" });
    await vi.waitFor(() => expect(dialog.showMessageBox).toHaveBeenCalledWith({ type: "error", title: "Failed", message: "Still connected", buttons: ["OK"] }));
  });
});
