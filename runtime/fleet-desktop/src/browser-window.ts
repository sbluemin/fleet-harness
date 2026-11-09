import type { HandlerDetails, WebContents, WebContentsView, WebPreferences, WindowOpenHandlerResponse } from "electron";
import { DESKTOP_BROWSER_WINDOW_PAGE, type DesktopBrowserSurface, type DesktopBrowserSurfaceRelay } from "@fleet-console/protocol/desktop";
import type { DesktopShellWindow } from "./shell-window.js";
import type { BrowserPane } from "./browser-pane.js";

/** 생성 전 override와 기존 guest 입양에 같은 명시적 보안 값만 사용한다. */
export const BROWSER_COMPANION_PREFERENCES = {
  sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false,
  nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webviewTag: false, allowRunningInsecureContent: false,
} as const satisfies WebPreferences;

export interface BrowserWindowDeps {
  readonly main: () => DesktopShellWindow | null;
  readonly createWindow: (guest: WebContents, view?: WebContentsView) => DesktopShellWindow;
  readonly createPane?: (guest: WebContents, view?: WebContentsView) => BrowserPane;
  readonly relay: (surface: DesktopBrowserSurfaceRelay) => void;
  readonly changed: () => void;
}

/** Console의 single-use intent가 연 문서는 하나다. 칸↔창 전환은 그 뷰의 부모만 바꾼다. */
export function createBrowserCompanion(deps: BrowserWindowDeps) {
  let intent: DesktopBrowserSurface | null = null;
  const revoked = new Set<string>();
  let origin: string | null = null;
  let owner: WebContents | null = null;
  let companion: DesktopShellWindow | null = null;
  let pane: BrowserPane | null = null;
  let guestContents: WebContents | null = null;
  let consumed = false;
  let closing = false;
  let focusRequest = 0;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let disposeOwner: (() => void) | null = null;

  const clearHost = (): WebContentsView | undefined => {
    const old = companion;
    const chrome = pane?.view ?? old?.consoleView;
    companion = null;
    const previousPane = pane;
    pane = null;
    previousPane?.dispose();
    if (old && chrome && !old.isDestroyed()) old.base.contentView.removeChildView(chrome);
    // BaseWindow를 없애기 전에 페이지를 main 뒤로 옮긴다. 문서는 닫지 않는다.
    deps.changed();
    if (old && !old.isDestroyed()) old.base.destroy();
    return chrome;
  };

  const revoke = (report: boolean): void => {
    const previous = intent;
    if (previous) revoked.add(previous.id);
    intent = null;
    origin = null;
    owner = null;
    consumed = false;
    closing = false;
    focusRequest = 0;
    if (deadline) clearTimeout(deadline);
    deadline = null;
    disposeOwner?.();
    disposeOwner = null;
    const oldContents = guestContents;
    guestContents = null;
    clearHost();
    if (oldContents && !oldContents.isDestroyed()) oldContents.close();
    if (report && previous) deps.relay({ id: previous.id, status: "closed" });
  };

  const armDeadline = (id: string, milliseconds: number): void => {
    if (deadline) clearTimeout(deadline);
    deadline = setTimeout(() => { if (intent?.id === id) revoke(true); }, milliseconds);
  };

  const mainFrameOnly = (contents: WebContents, activeOrigin: string): boolean => {
    try {
      const frame = contents.mainFrame;
      return frame.url === contents.getURL() && new URL(frame.url).origin === activeOrigin && frame.url.startsWith(`${activeOrigin}/console/`)
        && frame.framesInSubtree.length === 1 && frame.framesInSubtree[0] === frame;
    } catch { return false; }
  };

  const installHost = (guest: WebContents, current: DesktopBrowserSurface, view?: WebContentsView): void => {
    const child = current.mode === "pane" ? null : view ? deps.createWindow(guest, view) : deps.createWindow(guest);
    const createdPane = current.mode === "pane" ? (view ? deps.createPane!(guest, view) : deps.createPane!(guest)) : null;
    if ((child?.consoleContents ?? createdPane?.contents) !== guest) throw new Error("browser_surface_guest_replaced");
    companion = child;
    pane = createdPane;
    closing = false;
    if (!child) return;
    // 끝난 창의 늦은 close/resize는 같은 문서를 옮긴 새 칸을 철회하지 않는다.
    const ownsHost = () => companion === child && guestContents === guest && intent?.id === current.id;
    child.base.on("close", (event) => {
      if (!ownsHost()) return;
      event.preventDefault();
      if (closing) return;
      closing = true;
      deps.relay({ id: current.id, status: "closing" });
      armDeadline(current.id, 3_000);
    });
    child.base.on("closed", () => { if (ownsHost()) revoke(true); });
    const changed = () => { if (ownsHost()) deps.changed(); };
    child.base.on("resize", changed);
    child.base.on("move", changed);
    child.base.on("minimize", changed);
    child.base.on("restore", changed);
    child.base.on("hide", changed);
    child.base.on("show", changed);
  };

  const apply = (next: DesktopBrowserSurface | null, at: string | null): void => {
    if (next && intent?.id === next.id && at === origin) {
      if (next.clientId !== intent.clientId || next.browserId !== intent.browserId) return;
      const previousMode = intent.mode ?? "window";
      intent = next;
      if (guestContents && previousMode !== (next.mode ?? "window")) {
        if (next.mode === "pane" && !deps.createPane) { revoke(true); return; }
        const guest = guestContents;
        const chrome = clearHost();
        try { installHost(guest, next, chrome); } catch { revoke(true); return; }
        if (deadline) clearTimeout(deadline);
        deadline = null;
        companion?.show();
        pane?.show();
        deps.relay({ id: next.id, status: "opened" });
        deps.changed();
      }
      if ((next.focusRequest ?? 0) > focusRequest) {
        focusRequest = next.focusRequest!;
        pane?.focus();
        const child = companion;
        if (child && !child.isDestroyed() && !closing) {
          if (child.isMinimized()) child.restore();
          child.show();
          child.focus();
        }
      }
      return;
    }
    if (!next && !intent) return;
    revoke(false);
    if (next && revoked.has(next.id)) return;
    const main = deps.main();
    if (!next || !at || !main || main.isDestroyed() || (next.mode === "pane" && !deps.createPane)) return;
    intent = next;
    origin = at;
    owner = main.consoleContents;
    const contents = owner;
    // policy가 취소한 항해 시도는 새 수명이 아니다. 실제 문서 commit/reload에서만 철회한다.
    const ownsIntent = () => intent?.id === next.id && owner === contents;
    const navigated = () => { if (ownsIntent()) revoke(true); };
    const gone = () => { if (ownsIntent()) revoke(true); };
    contents.on("did-navigate", navigated);
    // error page commit은 did-navigate 대신 새 main DOM의 적재로 잡는다.
    contents.on("dom-ready", navigated);
    contents.on("render-process-gone", gone);
    contents.on("destroyed", gone);
    disposeOwner = () => { contents.removeListener("did-navigate", navigated); contents.removeListener("dom-ready", navigated); contents.removeListener("render-process-gone", gone); contents.removeListener("destroyed", gone); };
    armDeadline(next.id, 10_000);
    deps.relay({ id: next.id, status: "ready" });
  };

  const open = (contents: WebContents, details: HandlerDetails, activeOrigin: string): WindowOpenHandlerResponse | null => {
    let url: URL;
    try { url = new URL(details.url); } catch { return null; }
    if (url.pathname !== DESKTOP_BROWSER_WINDOW_PAGE) return null;
    const deny: WindowOpenHandlerResponse = { action: "deny" };
    if (!intent || consumed || guestContents || owner !== contents || origin !== activeOrigin || url.href !== `${activeOrigin}${DESKTOP_BROWSER_WINDOW_PAGE}`
      || url.username || url.password || url.search || url.hash || details.postBody || details.frameName !== intent.id) return deny;
    // 요청 frame을 이름/referrer로 추측하지 않는다. 하위 frame이 하나라도 있으면 생성 자체를 거부한다.
    if (!mainFrameOnly(contents, activeOrigin)) return deny;
    consumed = true;
    const current = intent;
    return {
      action: "allow", outlivesOpener: false,
      overrideBrowserWindowOptions: {
        show: false, width: 1000, height: 760, minWidth: 460, minHeight: 360, title: "Fleet Browser",
        frame: true, movable: true, resizable: true, minimizable: true, maximizable: true, fullscreenable: true, alwaysOnTop: false,
        webPreferences: { ...BROWSER_COMPANION_PREFERENCES, session: contents.session },
      },
      createWindow: (options) => {
        if (intent !== current || owner !== contents || guestContents || contents.isDestroyed() || !mainFrameOnly(contents, activeOrigin)) throw new Error("browser_surface_revoked");
        // Electron 43은 기존 guest를 options.webContents로 건넨다. 옵션 복제나 새 WC 생성은 opener를 끊는다.
        const guest = (options as { readonly webContents?: WebContents }).webContents;
        let valid = false;
        try { valid = Boolean(guest && guest !== contents && !guest.isDestroyed() && guest.opener === contents.mainFrame && guest.session === contents.session); } catch { /* 사라진 contents는 입양하지 않는다. */ }
        if (!valid || !guest) throw new Error("browser_surface_guest_invalid");
        installHost(guest, current);
        guestContents = guest;
        const wc = guest;
        const initialUrl = `${activeOrigin}${DESKTOP_BROWSER_WINDOW_PAGE}`;
        let loaded = false;
        let initialStarted = false;
        let initialFrameAllowed = false;
        let initialMainAllowed = false;
        const ownsChild = () => guestContents === wc && intent?.id === current.id;
        const initial = (url: string) => ownsChild() && !loaded && url === initialUrl;
        // 최초 항해의 frame/main 취소 지점만 한 번씩 통과시킨다. did-start는 이 토큰들을 소비하지 않는다.
        wc.on("will-frame-navigate", (event) => {
          if (!event.isMainFrame || initialFrameAllowed || !initial(event.url)) { event.preventDefault(); return; }
          initialFrameAllowed = true;
        });
        wc.on("will-navigate", (event, url) => {
          if (initialMainAllowed || !initial(url)) { event.preventDefault(); return; }
          initialMainAllowed = true;
        });
        wc.on("will-redirect", (event) => event.preventDefault());
        wc.on("will-attach-webview", (event) => event.preventDefault());
        wc.setWindowOpenHandler(() => ({ action: "deny" }));
        wc.on("render-process-gone", () => { if (ownsChild()) revoke(true); });
        wc.on("destroyed", () => { if (ownsChild()) revoke(true); });
        wc.on("did-start-navigation", (_event, url, inPlace, isMainFrame) => {
          if (!ownsChild() || !isMainFrame) return;
          if (initialStarted || inPlace || !initial(url)) { revoke(true); return; }
          initialStarted = true;
        });
        wc.once("did-finish-load", () => {
          if (!ownsChild()) return;
          if (wc.getURL() !== initialUrl) { revoke(true); return; }
          loaded = true;
          if (deadline) clearTimeout(deadline);
          deadline = null;
          deps.relay({ id: current.id, status: "opened" });
          companion?.show();
          pane?.show();
          deps.changed();
        });
        return wc;
      },
    };
  };

  return {
    apply, open,
    surface(id?: string | null): DesktopShellWindow | null {
      const host = pane?.host ?? companion;
      return id && intent?.id === id && host && !host.isDestroyed() ? host : null;
    },
    contents(id?: string | null): WebContents | null { return id && intent?.id === id ? guestContents : null; },
    paneBounds(id?: string | null) { return id && intent?.id === id ? pane?.bounds() ?? null : null; },
    dispose(): void { revoke(false); },
  };
}
export type BrowserCompanion = ReturnType<typeof createBrowserCompanion>;
