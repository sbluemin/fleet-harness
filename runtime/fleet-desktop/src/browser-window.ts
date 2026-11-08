import type { HandlerDetails, WebContents, WebPreferences, WindowOpenHandlerResponse } from "electron";
import { DESKTOP_BROWSER_WINDOW_PAGE, type DesktopBrowserSurface, type DesktopBrowserSurfaceRelay } from "@fleet-console/protocol/desktop";
import type { DesktopShellWindow } from "./shell-window.js";

/** 생성 전 override와 기존 guest 입양에 같은 명시적 보안 값만 사용한다. */
export const BROWSER_COMPANION_PREFERENCES = {
  sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false,
  nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webviewTag: false, allowRunningInsecureContent: false,
} as const satisfies WebPreferences;

export interface BrowserWindowDeps {
  readonly main: () => DesktopShellWindow | null;
  readonly createWindow: (guest: WebContents) => DesktopShellWindow;
  readonly relay: (surface: DesktopBrowserSurfaceRelay) => void;
  readonly changed: () => void;
}

/** 셸은 콘텐츠를 만들지 않는다. Console의 한 번짜리 intent를 받아 수동 문서의 native 자리만 만든다. */
export function createBrowserCompanion(deps: BrowserWindowDeps) {
  let intent: DesktopBrowserSurface | null = null;
  const revoked = new Set<string>();
  let origin: string | null = null;
  let owner: WebContents | null = null;
  let companion: DesktopShellWindow | null = null;
  let consumed = false;
  let closing = false;
  let focusRequest = 0;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let disposeOwner: (() => void) | null = null;

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
    const old = companion;
    companion = null;
    // BaseWindow를 없애기 전에 기존 native 뷰를 살아 있는 main 뒤로 옮긴다.
    deps.changed();
    if (old && !old.isDestroyed()) old.base.destroy();
    if (old && !old.consoleContents.isDestroyed()) old.consoleContents.close();
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

  const apply = (next: DesktopBrowserSurface | null, at: string | null): void => {
    if (next?.id === intent?.id && at === origin) {
      if (next && intent && next.clientId === intent.clientId && next.browserId === intent.browserId && (next.focusRequest ?? 0) > focusRequest) {
        focusRequest = next.focusRequest!;
        const child = companion;
        if (child && !child.isDestroyed() && !closing) {
          if (child.isMinimized()) child.restore();
          child.show();
          child.focus();
        }
      }
      return;
    }
    revoke(false);
    if (next && revoked.has(next.id)) return;
    const main = deps.main();
    if (!next || !at || !main || main.isDestroyed()) return;
    intent = next;
    origin = at;
    owner = main.consoleContents;
    const contents = owner;
    // 항해 시도는 policy에서 취소될 수 있다. 실제 main 문서 commit/reload에서만 새 수명으로 읽는다.
    // did-navigate는 commit된 cross-document main 항해만 알리므로 SPA/hash 이동은 유지한다.
    const ownsIntent = () => intent === next && owner === contents;
    const navigated = () => { if (ownsIntent()) revoke(true); };
    const gone = () => { if (ownsIntent()) revoke(true); };
    contents.on("did-navigate", navigated);
    // Electron은 error page commit에 did-navigate를 내지 않는다. 새 main DOM 적재도 실제 문서 교체다.
    contents.on("dom-ready", navigated);
    contents.on("render-process-gone", gone);
    contents.on("destroyed", gone);
    disposeOwner = () => { contents.removeListener("did-navigate", navigated); contents.removeListener("dom-ready", navigated); contents.removeListener("render-process-gone", gone); contents.removeListener("destroyed", gone); };
    armDeadline(next.id, 10_000);
    deps.relay({ id: next.id, status: "ready" });
  };

  const open = (contents: WebContents, details: HandlerDetails, activeOrigin: string): WindowOpenHandlerResponse | null => {
    // 정확한 특례 경로를 닮은 요청은 외부 브라우저로도 보내지 않는다.
    let url: URL;
    try { url = new URL(details.url); } catch { return null; }
    if (url.pathname !== DESKTOP_BROWSER_WINDOW_PAGE) return null;
    const deny: WindowOpenHandlerResponse = { action: "deny" };
    if (!intent || consumed || companion || owner !== contents || origin !== activeOrigin || url.href !== `${activeOrigin}${DESKTOP_BROWSER_WINDOW_PAGE}`
      || url.username || url.password || url.search || url.hash || details.postBody || details.frameName !== intent.id) return deny;
    // 이 handler의 요청 프레임을 이름/referrer로 추측하지 않는다. 하위 frame이 하나라도 있으면 생성 자체를 거부한다.
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
        // allow 이후 renderer가 교체되거나 intent가 철회되었다면 새 native 자원을 만들지 않는다.
        if (intent !== current || owner !== contents || companion || contents.isDestroyed() || !mainFrameOnly(contents, activeOrigin)) throw new Error("browser_surface_revoked");
        // Electron 43의 createWindow는 이미 생성한 guest를 options.webContents로 건넨다.
        // 공개 callback 옵션 타입에는 없는 전달 필드만 좁게 읽는다. 새 WC나 옵션 전체 복제는 opener를 끊는다.
        const guest = (options as { readonly webContents?: WebContents }).webContents;
        let valid = false;
        try {
          // 보안 값은 위 override가 guest 생성 전에 적용한다. identity 검증은 공개 WC API만 사용한다.
          valid = Boolean(guest && guest !== contents && !guest.isDestroyed() && guest.opener === contents.mainFrame && guest.session === contents.session);
        } catch { /* 사라졌거나 예상하지 못한 contents는 입양하지 않는다. */ }
        if (!valid || !guest) throw new Error("browser_surface_guest_invalid");
        const child = deps.createWindow(guest);
        if (child.consoleContents !== guest) throw new Error("browser_surface_guest_replaced");
        companion = child;
        const wc = child.consoleContents;
        const initialUrl = `${activeOrigin}${DESKTOP_BROWSER_WINDOW_PAGE}`;
        let loaded = false;
        let initialStarted = false;
        let initialFrameAllowed = false;
        let initialMainAllowed = false;
        const ownsChild = () => companion === child && intent === current;
        const initial = (url: string) => ownsChild() && !loaded && url === initialUrl;
        // window.open의 최초 항해도 renderer 항해다. frame/main 취소 지점은 각각 한 번만 통과시키며,
        // did-start 알림은 이 토큰들을 소비하지 않는다 — 알림과 throttle의 순서에 기대지 않는다.
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
        // 종료한 guest의 늦은 이벤트는 새로 연 child/intent를 철회하지 못한다.
        wc.on("render-process-gone", () => { if (ownsChild()) revoke(true); });
        wc.on("destroyed", () => { if (ownsChild()) revoke(true); });
        wc.on("did-start-navigation", (_event, url, inPlace, isMainFrame) => {
          if (!ownsChild() || !isMainFrame) return;
          if (initialStarted || inPlace || !initial(url)) { revoke(true); return; }
          initialStarted = true;
        });
        wc.once("did-finish-load", () => {
          if (!ownsChild()) return;
          if (wc.getURL() !== `${activeOrigin}${DESKTOP_BROWSER_WINDOW_PAGE}`) { revoke(true); return; }
          loaded = true;
          if (deadline) clearTimeout(deadline);
          deadline = null;
          deps.relay({ id: current.id, status: "opened" });
          child.show();
          deps.changed();
        });
        child.base.on("close", (event) => {
          if (!ownsChild()) return;
          event.preventDefault();
          if (closing) return;
          closing = true;
          deps.relay({ id: current.id, status: "closing" });
          armDeadline(current.id, 3_000);
        });
        child.base.on("closed", () => { if (ownsChild()) revoke(true); });
        child.base.on("resize", () => deps.changed());
        child.base.on("move", () => deps.changed());
        child.base.on("minimize", () => deps.changed());
        child.base.on("restore", () => deps.changed());
        child.base.on("hide", () => deps.changed());
        child.base.on("show", () => deps.changed());
        return wc;
      },
    };
  };

  return {
    apply, open,
    surface(id?: string | null): DesktopShellWindow | null { return id && intent?.id === id && companion && !companion.isDestroyed() ? companion : null; },
    dispose(): void { revoke(false); },
  };
}
export type BrowserCompanion = ReturnType<typeof createBrowserCompanion>;
