import { describe, expect, it, vi } from "vitest";

import { applyWindowPolicy, confinePickerNavigation, createSecureWindow, isAllowedConsoleUrl } from "../src/window-policy.js";

const HOME = "http://127.0.0.1:4310";

function createPickerContents() {
  const listeners = new Map<string, (...args: never[]) => unknown>();
  const session = { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn() };
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

    expect(session.setPermissionCheckHandler).not.toHaveBeenCalled();
    expect(session.setPermissionRequestHandler).not.toHaveBeenCalled();
  });
});

describe("secure window policy", () => {
  it("creates a renderer without Node or preload privilege", () => {
    const Ctor = vi.fn();
    createSecureWindow(Ctor as never, { iconPath: "/assets/icon.png", platform: "darwin" });
    expect(Ctor).toHaveBeenCalledWith({ show: false, title: "Fleet Console", icon: "/assets/icon.png", backgroundColor: "#010204", minWidth: 900, minHeight: 560, titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 14 }, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  });

  it("allows only exact-origin Console routes", () => {
    expect(isAllowedConsoleUrl("http://127.0.0.1:4310/console/operations", "http://127.0.0.1:4310")).toBe(true);
    expect(isAllowedConsoleUrl("http://localhost:4310/console/operations", "http://127.0.0.1:4310")).toBe(false);
    expect(isAllowedConsoleUrl("http://127.0.0.1:4310/api/v1/status", "http://127.0.0.1:4310")).toBe(false);
  });

  it("locks the entry renderer until the main process activates one exact Console origin", () => {
    const listeners = new Map<string, (...args: never[]) => unknown>();
    const contents = { on: vi.fn((name: string, listener: (...args: never[]) => unknown) => listeners.set(name, listener)), setWindowOpenHandler: vi.fn(), session: { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn() } };
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

  it("allows clipboard writes only after activating the exact Console origin", () => {
    const listeners = new Map<string, (...args: never[]) => unknown>();
    const session = { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn() };
    const contents = { on: vi.fn((name: string, listener: (...args: never[]) => unknown) => listeners.set(name, listener)), setWindowOpenHandler: vi.fn(), session };
    const policy = applyWindowPolicy(contents as never, async () => undefined);
    const check = session.setPermissionCheckHandler.mock.calls[0]![0] as (requestingContents: unknown, permission: string, requestingOrigin: string, details: { requestingUrl?: string }) => boolean;
    const request = session.setPermissionRequestHandler.mock.calls[0]![0] as (_contents: unknown, permission: string, callback: (allowed: boolean) => void, details: { requestingUrl: string }) => void;

    expect(check(contents, "clipboard-sanitized-write", HOME, { requestingUrl: `${HOME}/console/settings` })).toBe(false);
    policy.activateConsoleOrigin(HOME);
    // Windows의 clipboard check는 origin 대신 빈 문자열을 넘길 수 있으므로 마지막 frame URL로 판정한다.
    expect(check(contents, "clipboard-sanitized-write", "", { requestingUrl: `${HOME}/console/settings` })).toBe(true);
    expect(check(null, "clipboard-sanitized-write", "", { requestingUrl: `${HOME}/console/settings` })).toBe(true);
    expect(check(contents, "clipboard-read", HOME, { requestingUrl: `${HOME}/console/settings` })).toBe(false);
    expect(check(contents, "clipboard-sanitized-write", "", { requestingUrl: "http://localhost:4310/console/settings" })).toBe(false);
    expect(check({}, "clipboard-sanitized-write", HOME, { requestingUrl: `${HOME}/console/settings` })).toBe(false);

    const callback = vi.fn();
    request(null, "clipboard-sanitized-write", callback, { requestingUrl: `${HOME}/console/settings` });
    expect(callback).toHaveBeenCalledWith(true);
    request(null, "clipboard-sanitized-write", callback, { requestingUrl: "https://fleet.example/console/settings" });
    expect(callback).toHaveBeenLastCalledWith(false);
  });

  it("blocks popups and navigation while brokering HTTP links only", async () => {
    const listeners = new Map<string, (...args: never[]) => unknown>();
    const openExternal = vi.fn(async () => undefined);
    const contents = { on: vi.fn((name: string, listener: (...args: never[]) => unknown) => listeners.set(name, listener)), setWindowOpenHandler: vi.fn(), session: { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn() } };
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
