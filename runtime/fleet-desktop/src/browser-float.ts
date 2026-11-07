import type { BrowserWindow, Rectangle } from "electron";
import { DESKTOP_BROWSER_FLOAT_PAGE, type DesktopBrowserFloat } from "@fleet-console/protocol/desktop";
import type { DesktopShellWindow } from "./shell-window.js";

/**
 * 브라우저 자리를 덮는 Console 메뉴를 그리는 작은 투명 자식 창.
 *
 * 네이티브 브라우저 뷰는 Console 위에 놓이므로 그 자리의 DOM 메뉴는 뷰 뒤로 가려진다. 뷰를 물리는 대신 메인 창의 자식 창
 * 하나를 메뉴 자리에 띄우고, 그 안에 Console 소유 표면(`/console/browser-float.html`)을 연다. 메뉴의 모양과 누른 항목은
 * 두 렌더러가 같은 출처 채널로 주고받는다 — 셸은 자리만 맞추고 내용은 모른다.
 *
 * 창은 포커스를 받지 않고(macOS 비활성 패널), 첫 클릭부터 받아 메인 창의 입력 포커스(주소 입력 등)를 빼앗지 않는다.
 * 하나를 만들어 다시 쓰고, 메뉴가 닫히면 감추기만 한다. 웹 팝업이 아니라 셸이 만든 창이며 Console 경로 밖으로 가지 않는다.
 */
export interface DesktopBrowserFloatDeps {
  readonly shell: () => DesktopShellWindow | null;
  /** 메인 창을 부모로 둔 자식 창을 만든다 — 같은 세션(같은 출처 채널)·샌드박스·투명·비활성. */
  readonly createWindow: (shell: DesktopShellWindow) => BrowserWindow;
  /** 콘솔 렌더러의 줌 — 메뉴의 CSS px 를 DIP 로 바꾸고 표면도 같은 배율로 그린다. */
  readonly zoomFactor: () => number;
  readonly log?: (message: string) => void;
}

export interface DesktopBrowserFloatWindow {
  /** 스냅샷의 메뉴 자리. `origin` 은 지금 창이 보여 주는 Console. */
  apply(float: DesktopBrowserFloat | null, origin: string | null): void;
  /** 창이 움직이거나 줌이 바뀌었다 — 마지막 자리로 다시 놓는다. */
  refresh(): void;
  dispose(): void;
}

export function floatScreenBounds(float: DesktopBrowserFloat, content: Rectangle, zoom: number): Rectangle {
  const factor = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return {
    x: Math.round(content.x + float.bounds.x * factor),
    y: Math.round(content.y + float.bounds.y * factor),
    width: Math.max(1, Math.round(float.bounds.width * factor)),
    height: Math.max(1, Math.round(float.bounds.height * factor)),
  };
}

export function createDesktopBrowserFloat(deps: DesktopBrowserFloatDeps): DesktopBrowserFloatWindow {
  let window: BrowserWindow | null = null;
  let owner: DesktopShellWindow | null = null;
  let loadedUrl: string | null = null;
  let current: DesktopBrowserFloat | null = null;
  let currentOrigin: string | null = null;

  const hide = (): void => {
    if (window && !window.isDestroyed() && window.isVisible()) window.hide();
  };

  const ensure = (shell: DesktopShellWindow, origin: string): BrowserWindow | null => {
    if (window && (window.isDestroyed() || owner !== shell)) {
      if (!window.isDestroyed()) window.destroy();
      window = null;
      loadedUrl = null;
    }
    if (!window) {
      window = deps.createWindow(shell);
      owner = shell;
      const contents = window.webContents;
      // 표면은 한 문서뿐이다 — 어디로도 항해하지 않고, 새 창도 열지 않는다.
      contents.on("will-navigate", (event) => event.preventDefault());
      contents.on("will-attach-webview", (event) => event.preventDefault());
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.on("closed", () => { window = null; owner = null; loadedUrl = null; });
    }
    const url = `${origin}${DESKTOP_BROWSER_FLOAT_PAGE}`;
    if (loadedUrl !== url) {
      loadedUrl = url;
      void window.webContents.loadURL(url).catch((error: unknown) => {
        loadedUrl = null;
        deps.log?.(`browser float load failed: ${error instanceof Error ? error.message : "unknown"}`);
      });
    }
    return window;
  };

  const place = (): void => {
    const shell = deps.shell();
    if (!current || !currentOrigin || !shell || shell.isDestroyed() || shell.isMinimized()) { hide(); return; }
    const target = ensure(shell, currentOrigin);
    if (!target || target.isDestroyed()) return;
    const zoom = deps.zoomFactor();
    if (target.webContents.getZoomFactor() !== zoom) target.webContents.setZoomFactor(zoom);
    target.setBounds(floatScreenBounds(current, shell.getContentBounds(), zoom));
    if (!target.isVisible()) target.showInactive();
  };

  return {
    apply(float, origin): void {
      current = float;
      currentOrigin = origin;
      if (!float || !origin) { hide(); return; }
      place();
    },
    refresh(): void {
      if (current) place();
    },
    dispose(): void {
      current = null;
      if (window && !window.isDestroyed()) window.destroy();
      window = null;
      owner = null;
      loadedUrl = null;
    },
  };
}
