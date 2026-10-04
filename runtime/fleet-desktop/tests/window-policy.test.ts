import { describe, expect, it, vi } from "vitest";

import { applyWindowPolicy, confinePickerNavigation, createSecureShellWindow, INITIAL_WINDOWS_TITLE_BAR_OVERLAY, isAllowedConsoleUrl } from "../src/window-policy.js";

const HOME = "http://127.0.0.1:4310";

function createPickerContents() {
  const listeners = new Map<string, (...args: never[]) => unknown>();
  const session = { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(), setDisplayMediaRequestHandler: vi.fn() };
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
  it("creates a BaseWindow shell with sandboxed Console view and no Node privilege", () => {
    const baseCtor = vi.fn(function BaseWindow(this: Record<string, unknown>) {
      this.getContentBounds = () => ({ x: 0, y: 0, width: 1200, height: 800 });
      this.contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
    });
    const viewCtor = vi.fn(function WebContentsView(this: Record<string, unknown>) {
      this.setBackgroundColor = vi.fn();
      this.setBounds = vi.fn();
      this.webContents = {};
    });
    const shell = createSecureShellWindow(baseCtor as never, viewCtor as never, { iconPath: "/assets/icon.png", platform: "darwin" });
    expect(baseCtor).toHaveBeenCalledWith({ show: false, title: "Fleet Console", icon: "/assets/icon.png", backgroundColor: "#010204", minWidth: 900, minHeight: 560, titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 11 } });
    expect(viewCtor).toHaveBeenCalledWith({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false } });
    expect(shell.consoleView.setBackgroundColor).toHaveBeenCalledWith("#010204");
  });

  it("applies Windows title-bar overlay on the BaseWindow shell", () => {
    const baseCtor = vi.fn(function BaseWindow(this: Record<string, unknown>) {
      this.getContentBounds = () => ({ x: 0, y: 0, width: 1200, height: 800 });
      this.contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
    });
    const viewCtor = vi.fn(function WebContentsView(this: Record<string, unknown>) {
      this.setBackgroundColor = vi.fn();
      this.setBounds = vi.fn();
      this.webContents = {};
    });
    createSecureShellWindow(baseCtor as never, viewCtor as never, { iconPath: "/assets/icon.png", platform: "win32" });
    expect(baseCtor).toHaveBeenCalledWith({ show: false, title: "Fleet Console", icon: "/assets/icon.png", backgroundColor: "#010204", minWidth: 900, minHeight: 560, titleBarStyle: "hidden", titleBarOverlay: INITIAL_WINDOWS_TITLE_BAR_OVERLAY });
    expect(viewCtor).toHaveBeenCalledWith({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false } });
  });

  it("allows only exact-origin Console routes", () => {
    expect(isAllowedConsoleUrl("http://127.0.0.1:4310/console/operations", "http://127.0.0.1:4310")).toBe(true);
    expect(isAllowedConsoleUrl("http://localhost:4310/console/operations", "http://127.0.0.1:4310")).toBe(false);
    expect(isAllowedConsoleUrl("http://127.0.0.1:4310/api/v1/status", "http://127.0.0.1:4310")).toBe(false);
  });

  it("locks the entry renderer until the main process activates one exact Console origin", () => {
    const listeners = new Map<string, (...args: never[]) => unknown>();
    const contents = { on: vi.fn((name: string, listener: (...args: never[]) => unknown) => listeners.set(name, listener)), setWindowOpenHandler: vi.fn(), session: { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(), setDisplayMediaRequestHandler: vi.fn() } };
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
    const session = { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(), setDisplayMediaRequestHandler: vi.fn() };
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
    expect(check(contents, "display-capture", HOME, { requestingUrl: `${HOME}/console/settings` })).toBe(true);
    expect(check(null, "display-capture", HOME, { requestingUrl: `${HOME}/console/settings` })).toBe(false);
    expect(check(contents, "display-capture", "https://fleet.example", { requestingUrl: "https://fleet.example/console/settings" })).toBe(false);
    expect(check(contents, "media", HOME, { requestingUrl: `${HOME}/console/settings` })).toBe(false);
    expect(check(contents, "clipboard-sanitized-write", "", { requestingUrl: "http://localhost:4310/console/settings" })).toBe(false);
    expect(check({}, "clipboard-sanitized-write", HOME, { requestingUrl: `${HOME}/console/settings` })).toBe(false);

    const callback = vi.fn();
    request(null, "clipboard-sanitized-write", callback, { requestingUrl: `${HOME}/console/settings` });
    expect(callback).toHaveBeenCalledWith(true);
    request(null, "clipboard-sanitized-write", callback, { requestingUrl: "https://fleet.example/console/settings" });
    expect(callback).toHaveBeenLastCalledWith(false);
  });

  // 이 기기의 서체 목록은 핑거프린팅 표면이다. 이 기기의 Console 화면 main frame에는 바로 내주고, 승인된 원격
  // Console에는 사용자가 확인창에서 허용했을 때만 이 실행 동안 내준다. 거부도 기억해 확인창을 되풀이하지 않는다.
  it("grants local fonts to the loopback Console and to a remote one only after the user allows it", async () => {
    const REMOTE = "https://fleet.example:8443";
    const OTHER = "https://other.example:8443";
    const listeners = new Map<string, (...args: never[]) => unknown>();
    const session = { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(), setDisplayMediaRequestHandler: vi.fn() };
    const contents = { on: vi.fn((name: string, listener: (...args: never[]) => unknown) => listeners.set(name, listener)), setWindowOpenHandler: vi.fn(), session };
    let answer: (allowed: boolean) => void = () => undefined;
    const confirmRemoteLocalFonts = vi.fn((_origin: string) => new Promise<boolean>((resolve) => { answer = resolve; }));
    const policy = applyWindowPolicy(contents as never, async () => undefined, { confirmRemoteLocalFonts });
    const check = session.setPermissionCheckHandler.mock.calls[0]![0] as (requestingContents: unknown, permission: string, requestingOrigin: string, details: { requestingUrl?: string; isMainFrame: boolean }) => boolean;
    const request = session.setPermissionRequestHandler.mock.calls[0]![0] as (_contents: unknown, permission: string, callback: (allowed: boolean) => void, details: { requestingUrl: string; isMainFrame: boolean }) => void;
    const ask = (origin: string, isMainFrame = true) => {
      const preventDefault = vi.fn();
      (listeners.get("will-navigate") as (event: { preventDefault(): void }, url: string, isInPlace: boolean, isMainFrame: boolean) => void)({ preventDefault }, `${origin}/console/?desktop-surface=local-fonts`, false, isMainFrame);
      return preventDefault;
    };
    const fontsAllowed = (origin: string) => check(contents, "local-fonts", origin, { requestingUrl: `${origin}/console/settings`, isMainFrame: true });
    const callback = vi.fn();

    policy.activateConsoleOrigin(HOME);
    expect(fontsAllowed(HOME)).toBe(true);
    request(contents, "local-fonts", callback, { requestingUrl: `${HOME}/console/settings`, isMainFrame: true });
    expect(callback).toHaveBeenLastCalledWith(true);
    request(contents, "local-fonts", callback, { requestingUrl: `${HOME}/console/settings`, isMainFrame: false });
    expect(callback).toHaveBeenLastCalledWith(false);
    request(contents, "unknown", callback, { requestingUrl: `${HOME}/console/settings`, isMainFrame: true });
    expect(callback).toHaveBeenLastCalledWith(false);
    expect(check({}, "local-fonts", HOME, { requestingUrl: `${HOME}/console/settings`, isMainFrame: true })).toBe(false);
    // 루프백은 이미 허용돼 있으므로 신호는 묻지 않고 삼킨다.
    expect(ask(HOME)).toHaveBeenCalledOnce();
    expect(confirmRemoteLocalFonts).not.toHaveBeenCalled();

    policy.admitRemoteConsoleOrigin(REMOTE);
    policy.activateConsoleOrigin(REMOTE);
    expect(fontsAllowed(REMOTE)).toBe(false);
    // subframe의 신호는 묻지 않는다.
    ask(REMOTE, false);
    expect(confirmRemoteLocalFonts).not.toHaveBeenCalled();
    // 확인창이 떠 있는 동안 거듭된 신호는 두 번째 창을 띄우지 않는다.
    expect(ask(REMOTE)).toHaveBeenCalledOnce();
    ask(REMOTE);
    expect(confirmRemoteLocalFonts).toHaveBeenCalledOnce();
    expect(confirmRemoteLocalFonts).toHaveBeenLastCalledWith(REMOTE);
    answer(true);
    await vi.waitFor(() => expect(fontsAllowed(REMOTE)).toBe(true));
    request(contents, "local-fonts", callback, { requestingUrl: `${REMOTE}/console/settings`, isMainFrame: true });
    expect(callback).toHaveBeenLastCalledWith(true);
    expect(check({}, "local-fonts", REMOTE, { requestingUrl: `${REMOTE}/console/settings`, isMainFrame: true })).toBe(false);
    expect(check(contents, "local-fonts", REMOTE, { requestingUrl: `${REMOTE}/console/settings`, isMainFrame: false })).toBe(false);
    ask(REMOTE);
    expect(confirmRemoteLocalFonts).toHaveBeenCalledOnce();

    // 거부는 이 실행 동안 기억한다 — 원격 페이지가 신호를 되풀이해도 확인창은 다시 뜨지 않는다.
    policy.admitRemoteConsoleOrigin(OTHER);
    policy.activateConsoleOrigin(OTHER);
    ask(OTHER);
    answer(false);
    await vi.waitFor(() => expect(confirmRemoteLocalFonts).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fontsAllowed(OTHER)).toBe(false);
    ask(OTHER);
    expect(confirmRemoteLocalFonts).toHaveBeenCalledTimes(2);

    // 승인을 거둔 origin의 허용은 남지 않고, 활성 origin이 아닌 곳을 향한 신호는 묻지 않는다.
    policy.withdrawRemoteConsoleOrigin(REMOTE);
    policy.admitRemoteConsoleOrigin(REMOTE);
    policy.activateConsoleOrigin(REMOTE);
    expect(fontsAllowed(REMOTE)).toBe(false);
    ask(OTHER);
    expect(confirmRemoteLocalFonts).toHaveBeenCalledTimes(2);
    // 승인이 철회된 origin의 화면은 더 묻지 못한다.
    policy.withdrawRemoteConsoleOrigin(REMOTE);
    ask(REMOTE);
    expect(confirmRemoteLocalFonts).toHaveBeenCalledTimes(2);
    expect(fontsAllowed(REMOTE)).toBe(false);
  });

  it("blocks popups and navigation while brokering HTTP links only", async () => {
    const listeners = new Map<string, (...args: never[]) => unknown>();
    const openExternal = vi.fn(async () => undefined);
    const contents = { on: vi.fn((name: string, listener: (...args: never[]) => unknown) => listeners.set(name, listener)), setWindowOpenHandler: vi.fn(), session: { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(), setDisplayMediaRequestHandler: vi.fn() } };
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
