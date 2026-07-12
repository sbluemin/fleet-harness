import { describe, expect, it, vi } from "vitest";

import { applyWindowPolicy, createSecureWindow, isAllowedConsoleUrl } from "../src/window-policy.js";

describe("secure window policy", () => {
  it("creates a renderer without Node or preload privilege", () => {
    const Ctor = vi.fn();
    createSecureWindow(Ctor as never, { iconPath: "/assets/icon.png", platform: "darwin" });
    expect(Ctor).toHaveBeenCalledWith({ show: false, title: "Fleet Console", icon: "/assets/icon.png", backgroundColor: "#010204", minWidth: 900, minHeight: 560, titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 14 }, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  });

  it("uses a Command Band-sized Windows title bar overlay", () => {
    const Ctor = vi.fn();
    createSecureWindow(Ctor as never, { iconPath: "/assets/icon.png", platform: "win32" });

    expect(Ctor).toHaveBeenCalledWith({ show: false, title: "Fleet Console", icon: "/assets/icon.png", backgroundColor: "#010204", minWidth: 900, minHeight: 560, titleBarStyle: "hidden", titleBarOverlay: { color: "#090f15", symbolColor: "#989fa6", height: 43 }, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  });

  it("keeps the Linux native title bar without an overlay", () => {
    const Ctor = vi.fn();
    createSecureWindow(Ctor as never, { iconPath: "/assets/icon.png", platform: "linux" });

    expect(Ctor).toHaveBeenCalledWith({ show: false, title: "Fleet Console", icon: "/assets/icon.png", backgroundColor: "#010204", minWidth: 900, minHeight: 560, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  });

  it("allows only exact-origin Console routes", () => {
    expect(isAllowedConsoleUrl("http://127.0.0.1:4310/console/operations", "http://127.0.0.1:4310")).toBe(true);
    expect(isAllowedConsoleUrl("http://localhost:4310/console/operations", "http://127.0.0.1:4310")).toBe(false);
    expect(isAllowedConsoleUrl("http://127.0.0.1:4310/api/v1/status", "http://127.0.0.1:4310")).toBe(false);
  });

  it("locks the entry renderer until the main process activates one exact Console origin", () => {
    const listeners = new Map<string, (...args: never[]) => unknown>();
    const contents = { on: vi.fn((name: string, listener: (...args: never[]) => unknown) => listeners.set(name, listener)), setWindowOpenHandler: vi.fn(), session: { setPermissionRequestHandler: vi.fn() } };
    const policy = applyWindowPolicy(contents as never, async () => undefined);
    const before = vi.fn();
    (listeners.get("will-navigate") as ((event: { preventDefault(): void }, url: string) => void))({ preventDefault: before }, "http://127.0.0.1:4310/console/");
    expect(before).toHaveBeenCalledOnce();
    policy.activateConsoleOrigin("http://127.0.0.1:4310");
    const allowed = vi.fn();
    (listeners.get("will-navigate") as ((event: { preventDefault(): void }, url: string) => void))({ preventDefault: allowed }, "http://127.0.0.1:4310/console/");
    expect(allowed).not.toHaveBeenCalled();
    const rejected = vi.fn();
    (listeners.get("will-navigate") as ((event: { preventDefault(): void }, url: string) => void))({ preventDefault: rejected }, "http://localhost:4310/console/");
    expect(rejected).toHaveBeenCalledOnce();
    expect(() => policy.activateConsoleOrigin("https://fleet.example")).toThrow("window_policy_console_origin_not_loopback");
  });

  it("blocks popups and navigation while brokering HTTPS links only", async () => {
    const listeners = new Map<string, (...args: never[]) => unknown>();
    const openExternal = vi.fn(async () => undefined);
    const contents = { on: vi.fn((name: string, listener: (...args: never[]) => unknown) => listeners.set(name, listener)), setWindowOpenHandler: vi.fn(), session: { setPermissionRequestHandler: vi.fn() } };
    applyWindowPolicy(contents as never, "http://127.0.0.1:4310", openExternal);
    const handler = contents.setWindowOpenHandler.mock.calls[0]![0] as ({ url }: { url: string }) => { action: string };
    expect(handler({ url: "https://fleet.example/docs" })).toEqual({ action: "deny" });
    expect(handler({ url: "file:///tmp/secret" })).toEqual({ action: "deny" });
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith("https://fleet.example/docs"));
    const preventDefault = vi.fn();
    (listeners.get("will-navigate") as ((event: { preventDefault(): void }, url: string) => void))({ preventDefault }, "https://evil.example/");
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});
