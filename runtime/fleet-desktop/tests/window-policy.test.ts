import { describe, expect, it, vi } from "vitest";

import { confinePickerNavigation, createSecureShellWindow, createWindowPolicy, INITIAL_WINDOWS_TITLE_BAR_OVERLAY, installPermissionDispatcher, isAllowedConsoleUrl, type SurfaceAuthority } from "../src/window-policy.js";

const HOME = "http://127.0.0.1:4310";
const REMOTE = "https://100.84.12.7:6768";

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

  it("locks the local view until the main process activates one exact Console origin", () => {
    const listeners = new Map<string, (...args: never[]) => unknown>();
    const contents = { on: vi.fn((name: string, listener: (...args: never[]) => unknown) => listeners.set(name, listener)), setWindowOpenHandler: vi.fn() };
    const policy = createWindowPolicy(async () => undefined);
    policy.confineLocalView(contents as never);
    const navigate = (url: string) => {
      const preventDefault = vi.fn();
      (listeners.get("will-navigate") as ((event: { preventDefault(): void }, url: string) => void))({ preventDefault }, url);
      return preventDefault;
    };
    expect(navigate(`${HOME}/console/`)).toHaveBeenCalledOnce();
    policy.activateConsoleOrigin(HOME);
    expect(policy.localConsoleOrigin()).toBe(HOME);
    expect(navigate(`${HOME}/console/`)).not.toHaveBeenCalled();
    expect(navigate("http://localhost:4310/console/")).toHaveBeenCalledOnce();
    expect(() => policy.activateConsoleOrigin("https://fleet.example")).toThrow("window_policy_console_origin_not_admitted");
    // 지문을 대조해 들이지 않은 원격은 데이터 뷰에도 예약되지 않는다.
    expect(() => policy.stageDataOrigin("https://fleet.example")).toThrow("window_policy_console_origin_not_admitted");
  });

  /**
   * 세 뷰가 한 세션을 나눈다. 권한은 지금 권한을 가진 뷰 하나의 main frame만 받고, 화면 캡처는 로컬 뷰가
   * 권한을 가진 동안에만 된다 — 원격 콘솔을 보는 동안, 전환 중에, 뒤에 세워 둔 로컬 뷰에서는 되지 않는다.
   */
  it("grants permissions only to the view that holds the surface", () => {
    const session = { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn() };
    const local = { id: "local" };
    const data = { id: "data" };
    let holder: SurfaceAuthority | null = null;
    installPermissionDispatcher(session as never, () => holder);
    const check = session.setPermissionCheckHandler.mock.calls[0]![0] as (requestingContents: unknown, permission: string, requestingOrigin: string, details: { requestingUrl?: string; isMainFrame?: boolean }) => boolean;
    const request = session.setPermissionRequestHandler.mock.calls[0]![0] as (contents: unknown, permission: string, callback: (allowed: boolean) => void, details: { requestingUrl: string; isMainFrame: boolean; mediaTypes?: string[] }) => void;
    const requested = (contents: unknown, permission: string, url: string, extra: { isMainFrame?: boolean; mediaTypes?: string[] } = {}) => {
      const callback = vi.fn();
      request(contents, permission, callback, { requestingUrl: url, isMainFrame: extra.isMainFrame ?? true, ...(extra.mediaTypes ? { mediaTypes: extra.mediaTypes } : {}) });
      return callback.mock.calls[0]![0] as boolean;
    };

    // 전환 중에는 누구도 받지 않는다.
    expect(check(local, "clipboard-sanitized-write", HOME, { requestingUrl: `${HOME}/console/settings` })).toBe(false);
    expect(check(local, "display-capture", HOME, { requestingUrl: `${HOME}/console/` })).toBe(false);

    holder = { contents: local as never, origin: HOME, surface: "local" };
    // Windows의 clipboard check는 origin 대신 빈 문자열을 넘길 수 있으므로 마지막 frame URL로 판정한다.
    expect(check(local, "clipboard-sanitized-write", "", { requestingUrl: `${HOME}/console/settings` })).toBe(true);
    expect(check(null, "clipboard-sanitized-write", "", { requestingUrl: `${HOME}/console/settings` })).toBe(true);
    expect(check(local, "clipboard-read", HOME, { requestingUrl: `${HOME}/console/settings` })).toBe(false);
    expect(check(local, "display-capture", HOME, { requestingUrl: `${HOME}/console/`, isMainFrame: true })).toBe(true);
    expect(requested(local, "media", `${HOME}/console/`, { mediaTypes: [] })).toBe(true);
    expect(requested(local, "media", `${HOME}/console/`, { mediaTypes: [], isMainFrame: false })).toBe(false);
    expect(check(null, "display-capture", HOME, { requestingUrl: `${HOME}/console/` })).toBe(false);
    expect(check(data, "clipboard-sanitized-write", HOME, { requestingUrl: `${HOME}/console/settings` })).toBe(false);

    holder = { contents: data as never, origin: REMOTE, surface: "data" };
    // 원격 콘솔의 클립보드 쓰기는 그 콘솔의 기존 기능이다. 화면 캡처는 아니다.
    expect(requested(data, "clipboard-sanitized-write", `${REMOTE}/console/`)).toBe(true);
    expect(requested(data, "clipboard-sanitized-write", `${REMOTE}/console/`, { isMainFrame: false })).toBe(false);
    expect(check(data, "display-capture", REMOTE, { requestingUrl: `${REMOTE}/console/` })).toBe(false);
    expect(requested(data, "media", `${REMOTE}/console/`, { mediaTypes: [] })).toBe(false);
    // 뒤에 세워 둔 로컬 뷰는 아무것도 물려받지 않는다.
    expect(check(local, "display-capture", HOME, { requestingUrl: `${HOME}/console/` })).toBe(false);
    expect(requested(local, "clipboard-sanitized-write", `${HOME}/console/settings`)).toBe(false);
  });

  it("brokers HTTP links from the local view only; a data view opens nothing", async () => {
    const openExternal = vi.fn(async () => undefined);
    const policy = createWindowPolicy(openExternal);
    policy.activateConsoleOrigin(HOME);
    const localContents = { on: vi.fn(), setWindowOpenHandler: vi.fn() };
    const dataListeners = new Map<string, (...args: never[]) => unknown>();
    const dataContents = { on: vi.fn((name: string, listener: (...args: never[]) => unknown) => dataListeners.set(name, listener)), setWindowOpenHandler: vi.fn() };
    policy.confineLocalView(localContents as never);
    policy.confineDataView(dataContents as never);
    const localHandler = localContents.setWindowOpenHandler.mock.calls[0]![0] as ({ url }: { url: string }) => { action: string };
    const dataHandler = dataContents.setWindowOpenHandler.mock.calls[0]![0] as ({ url }: { url: string }) => { action: string };

    expect(localHandler({ url: "https://fleet.example/docs" })).toEqual({ action: "deny" });
    expect(localHandler({ url: "file:///tmp/secret" })).toEqual({ action: "deny" });
    expect(localHandler({ url: "javascript:alert('unsafe')" })).toEqual({ action: "deny" });
    expect(dataHandler({ url: "https://evil.example/" })).toEqual({ action: "deny" });
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1));
    expect(openExternal).toHaveBeenCalledWith("https://fleet.example/docs");

    // 데이터 뷰는 확정된 콘솔 origin의 /console/ 안에서만 움직인다.
    const preventDefault = vi.fn();
    (dataListeners.get("will-navigate") as ((event: { preventDefault(): void }, url: string) => void))({ preventDefault }, `${HOME}/console/`);
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});
