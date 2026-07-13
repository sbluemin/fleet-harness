import { describe, expect, it, vi } from "vitest";

import { createPairingNotifier } from "../src/pairing-notifications.js";

describe("pairing notifications", () => {
  it("uses Electron Notification when supported", () => {
    const show = vi.fn();
    class NotificationMock { static isSupported(): boolean { return true; } show = (): void => { show(); }; }
    const dialog = { showMessageBox: vi.fn(async () => undefined) };
    createPairingNotifier(NotificationMock, dialog).show({ type: "info", title: "Connected", body: "Ready" });
    expect(show).toHaveBeenCalledOnce();
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it("shows a visible native dialog fallback when Electron Notification is unavailable", async () => {
    const dialog = { showMessageBox: vi.fn(async () => undefined) };
    createPairingNotifier({ isSupported: () => false } as never, dialog).show({ type: "error", title: "Failed", body: "Still connected" });
    await vi.waitFor(() => expect(dialog.showMessageBox).toHaveBeenCalledWith({ type: "error", title: "Failed", message: "Still connected", buttons: ["OK"] }));
  });
});
