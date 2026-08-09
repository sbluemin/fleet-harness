import { describe, expect, it, vi } from "vitest";

import { applyWindowPolicy, confinePickerNavigation, createSecureWindow, isAllowedConsoleUrl } from "../src/window-policy.js";

const HOME = "http://127.0.0.1:4310";

function createPickerContents() {
  const listeners = new Map<string, (...args: never[]) => unknown>();
  const session = { setPermissionRequestHandler: vi.fn() };
  const contents = {
    on: vi.fn((name: string, listener: (...args: never[]) => unknown) => listeners.set(name, listener)),
    setWindowOpenHandler: vi.fn(),
    session,
  };
  return { contents, session, navigate: (url: string) => {
    const preventDefault = vi.fn();
    (listeners.get("will-navigate") as ((event: { preventDefault(): void }, url: string) => void))({ preventDefault }, url);
    return preventDefault;
  } };
}

describe("host picker view confinement", () => {
  /**
   * 이 뷰는 메인 창과 같은 defaultSession에 산다. applyWindowPolicy를 그대로 쓰면 세션 단위인
   * 권한 핸들러를 집 origin 기준으로 갈아 끼우고, 덮개를 걷어도 그대로 남아 원격 콘솔의
   * 클립보드 판정이 조용히 뒤집힌다. 그래서 세션에는 손대지 않는다.
   */
  it("never touches the session it shares with the main window", () => {
    const { contents, session } = createPickerContents();

    confinePickerNavigation(contents as never, HOME, () => false);

    expect(session.setPermissionRequestHandler).not.toHaveBeenCalled();
  });

  it("keeps the list on its own console and denies popups", () => {
    const { contents, navigate } = createPickerContents();
    confinePickerNavigation(contents as never, HOME, () => false);

    expect(navigate(`${HOME}/console/settings`)).not.toHaveBeenCalled();
    expect(navigate(`${HOME}/api/v1/remote-hosts`)).toHaveBeenCalledOnce();
    expect(navigate("https://100.84.12.7:6768/console/")).toHaveBeenCalledOnce();
    expect(contents.setWindowOpenHandler.mock.calls[0]?.[0]?.({ url: "https://example.com" })).toEqual({ action: "deny" });
  });

  /** 콘솔을 갈아타는 항해는 remote bridge가 같은 이벤트에서 가져간다 — 여기서 막을 일이 아니다. */
  it("leaves a console switch to the bridge", () => {
    const { contents, navigate } = createPickerContents();
    confinePickerNavigation(contents as never, HOME, (url) => url.startsWith("https://100.84.12.7:6768/console/"));

    expect(navigate("https://100.84.12.7:6768/console/")).not.toHaveBeenCalled();
  });
});

describe("secure window policy", () => {
  it("creates a renderer without Node or preload privilege", () => {
    const Ctor = vi.fn();
    createSecureWindow(Ctor as never, { iconPath: "/assets/icon.png", platform: "darwin" });
    expect(Ctor).toHaveBeenCalledWith({ show: false, title: "Fleet Console", icon: "/assets/icon.png", backgroundColor: "#010204", minWidth: 900, minHeight: 560, titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 14 }, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  });

  it("uses a Command Band-sized Windows title bar overlay", () => {
    const Ctor = vi.fn();
    createSecureWindow(Ctor as never, { iconPath: "/assets/icon.png", platform: "win32" });

    expect(Ctor).toHaveBeenCalledWith({ show: false, title: "Fleet Console", icon: "/assets/icon.png", backgroundColor: "#010204", minWidth: 900, minHeight: 560, autoHideMenuBar: false, titleBarStyle: "hidden", titleBarOverlay: { color: "#03080e", symbolColor: "#989fa6", height: 43 }, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  });

  it("keeps the Linux native title bar without an overlay", () => {
    const Ctor = vi.fn();
    createSecureWindow(Ctor as never, { iconPath: "/assets/icon.png", platform: "linux" });

    expect(Ctor).toHaveBeenCalledWith({ show: false, title: "Fleet Console", icon: "/assets/icon.png", backgroundColor: "#010204", minWidth: 900, minHeight: 560, autoHideMenuBar: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
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
    expect(policy.currentConsoleOrigin()).toBe("http://127.0.0.1:4310");
    const allowed = vi.fn();
    (listeners.get("will-navigate") as ((event: { preventDefault(): void }, url: string) => void))({ preventDefault: allowed }, "http://127.0.0.1:4310/console/");
    expect(allowed).not.toHaveBeenCalled();
    const rejected = vi.fn();
    (listeners.get("will-navigate") as ((event: { preventDefault(): void }, url: string) => void))({ preventDefault: rejected }, "http://localhost:4310/console/");
    expect(rejected).toHaveBeenCalledOnce();
    expect(() => policy.activateConsoleOrigin("https://fleet.example")).toThrow("window_policy_console_origin_not_admitted");
  });

  it("allows a pending target only until a transactional pairing commits it", () => {
    const listeners = new Map<string, (...args: never[]) => unknown>();
    const contents = { on: vi.fn((name: string, listener: (...args: never[]) => unknown) => listeners.set(name, listener)), setWindowOpenHandler: vi.fn(), session: { setPermissionRequestHandler: vi.fn() } };
    const policy = applyWindowPolicy(contents as never, "http://127.0.0.1:4000", async () => undefined);
    policy.stageConsoleOrigin("http://127.0.0.1:4310");
    const pendingAllowed = vi.fn();
    (listeners.get("will-navigate") as ((event: { preventDefault(): void }, url: string) => void))({ preventDefault: pendingAllowed }, "http://127.0.0.1:4310/console/");
    expect(pendingAllowed).not.toHaveBeenCalled();
    policy.cancelPendingConsoleOrigin();
    const cancelled = vi.fn();
    (listeners.get("will-navigate") as ((event: { preventDefault(): void }, url: string) => void))({ preventDefault: cancelled }, "http://127.0.0.1:4310/console/");
    expect(cancelled).toHaveBeenCalledOnce();
    policy.stageConsoleOrigin("http://127.0.0.1:4310");
    policy.commitConsoleOrigin();
    const committed = vi.fn();
    (listeners.get("will-navigate") as ((event: { preventDefault(): void }, url: string) => void))({ preventDefault: committed }, "http://127.0.0.1:4310/console/");
    expect(committed).not.toHaveBeenCalled();
  });

  it("blocks popups and navigation while brokering HTTP links only", async () => {
    const listeners = new Map<string, (...args: never[]) => unknown>();
    const openExternal = vi.fn(async () => undefined);
    const contents = { on: vi.fn((name: string, listener: (...args: never[]) => unknown) => listeners.set(name, listener)), setWindowOpenHandler: vi.fn(), session: { setPermissionRequestHandler: vi.fn() } };
    applyWindowPolicy(contents as never, "http://127.0.0.1:4310", openExternal);
    const handler = contents.setWindowOpenHandler.mock.calls[0]![0] as ({ url }: { url: string }) => { action: string };
    expect(handler({ url: "https://fleet.example/docs" })).toEqual({ action: "deny" });
    expect(handler({ url: "http://127.0.0.1:4173/preview" })).toEqual({ action: "deny" });
    expect(handler({ url: "file:///tmp/secret" })).toEqual({ action: "deny" });
    expect(handler({ url: "javascript:alert('unsafe')" })).toEqual({ action: "deny" });
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(2));
    expect(openExternal).toHaveBeenNthCalledWith(1, "https://fleet.example/docs");
    expect(openExternal).toHaveBeenNthCalledWith(2, "http://127.0.0.1:4173/preview");
    const preventDefault = vi.fn();
    (listeners.get("will-navigate") as ((event: { preventDefault(): void }, url: string) => void))({ preventDefault }, "https://evil.example/");
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});
