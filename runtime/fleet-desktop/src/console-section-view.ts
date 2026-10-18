import type { WebContents, WebContentsView } from "electron";
import { CONSOLE_SECTION_CONTEXT_EVENT, CONSOLE_SECTION_EVENT, CONSOLE_SECTION_FOCUS_EVENT, CONSOLE_SECTION_REFRESH_EVENT, CONSOLE_SECTION_SIGNAL, CONSOLE_SECTION_SURFACE, isConsoleSectionGeometry, type ConsoleSectionGeometry } from "@fleet-console/protocol/desktop/console-section";
import type { DesktopShellWindow } from "./shell-window.js";

interface ConsoleSectionViewDeps {
  readonly shell: () => DesktopShellWindow | null;
  readonly home: () => string | null;
  readonly createView: () => WebContentsView;
  readonly confine: (contents: WebContents) => void;
  readonly attachBridge: (contents: WebContents) => void;
  readonly log: (message: string) => void;
}

/** 집이 그리는 상주 뷰. 활성 Console에 보내는 데이터는 높이 하나뿐이다. */
export function createConsoleSectionView(deps: ConsoleSectionViewDeps) {
  let view: WebContentsView | null = null;
  let geometry: ConsoleSectionGeometry | null = null;
  let requestedHeight = 0;
  let failed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastContext = "";
  let generation = 0;
  let sender: WebContents | null = null;

  const dispatch = async (contents: WebContents, name: string, detail: unknown): Promise<void> => {
    if (contents.isDestroyed()) return;
    await contents.executeJavaScript(`window.dispatchEvent(new CustomEvent(${JSON.stringify(name)}, {detail:${JSON.stringify(detail)}}))`);
  };
  const publishHeight = (height: number | null) => {
    if (sender && !sender.isDestroyed()) void dispatch(sender, CONSOLE_SECTION_EVENT, height).catch(() => undefined);
  };
  const disposeView = () => {
    generation++;
    if (timer) clearTimeout(timer);
    timer = null;
    const old = view; view = null; requestedHeight = 0; lastContext = "";
    if (!old) return;
    try { deps.shell()?.stack.removeSection(old); } catch { /* 창이 먼저 닫혔다. */ }
    try { old.webContents.close(); } catch { /* 이미 죽은 렌더러다. */ }
  };
  const fail = (message: string) => {
    deps.log(`console section unavailable; using host picker: ${message}`);
    failed = true; disposeView(); publishHeight(null);
  };
  const currentOrigin = (): string | null => {
    try { return new URL(deps.shell()?.consoleContents.getURL() ?? "").origin; } catch { return null; }
  };
  const refresh = () => {
    const shell = deps.shell();
    if (!view || !shell || shell.isDestroyed()) return;
    const g = geometry;
    if (!g || !g.visible || g.width < 1) { view.setVisible(false); return; }
    const zoom = shell.consoleContents.getZoomFactor();
    view.webContents.setZoomFactor(zoom);
    const content = shell.getContentBounds();
    const x = Math.min(content.width - 1, Math.max(0, Math.round(g.x * zoom)));
    const y = Math.min(content.height - 1, Math.max(0, Math.round(g.y * zoom)));
    const maxHeight = Math.max(48, Math.min(g.available, (content.height - y) / zoom));
    const height = Math.min(requestedHeight, maxHeight);
    view.setBounds({ x, y, width: Math.max(1, Math.min(content.width - x, Math.round(g.width * zoom))), height: Math.max(1, Math.ceil(height * zoom)) });
    const at = currentOrigin();
    if (at) {
      const context = { at, compact: g.compact, maxHeight, theme: g.theme };
      const key = JSON.stringify(context);
      if (lastContext !== key) {
        lastContext = key;
        void dispatch(view.webContents, CONSOLE_SECTION_CONTEXT_EVENT, context).catch(() => { lastContext = ""; });
      }
    }
    if (requestedHeight > 0) {
      publishHeight(height);
      view.setVisible(true);
    }
  };
  const ensure = () => {
    if (view || failed || !geometry?.visible) return;
    const shell = deps.shell(); const home = deps.home();
    if (!shell || shell.isDestroyed() || !home) return;
    try {
      const created = deps.createView(); view = created;
      const thisGeneration = ++generation;
      const contents = created.webContents;
      shell.stack.presentSection(created); created.setVisible(false);
      deps.confine(contents);
      // 제어 신호는 remote bridge보다 먼저 가로챈다. 나머지 항해만 메인 Console로 전달된다.
      contents.on("will-navigate", (event, url) => {
        let parsed: URL;
        try { parsed = new URL(url); } catch { event.preventDefault(); return; }
        if (parsed.searchParams.get("desktop-surface") !== CONSOLE_SECTION_SIGNAL) return;
        event.preventDefault();
        if (parsed.origin !== home || new URL(contents.getURL()).origin !== home) return;
        const signal = parseSignal(parsed);
        if (!signal) return;
        if (typeof signal.height === "number" && Number.isFinite(signal.height) && signal.height > 0 && signal.height <= 100_000) {
          requestedHeight = signal.height;
          lastContext = "";
          if (timer) clearTimeout(timer);
          timer = null; refresh();
        }
        if (signal.focus === "before" || signal.focus === "after") {
          shell.consoleContents.focus();
          void dispatch(shell.consoleContents, CONSOLE_SECTION_FOCUS_EVENT, signal.focus).catch(() => undefined);
        }
      });
      deps.attachBridge(contents);
      contents.on("render-process-gone", () => { if (view === created) fail("renderer exited"); });
      contents.once("did-fail-load", (_event, _code, description) => { if (view === created) fail(description); });
      contents.on("did-finish-load", () => { lastContext = ""; refresh(); });
      // 구버전 집 Console은 이 표면을 모른다. 일반 앱을 겹쳐 띄우는 대신 덮개 경로로 돌아간다.
      timer = setTimeout(() => { if (generation === thisGeneration) fail("surface handshake timed out"); }, 8_000);
      const url = new URL("/console/", home); url.searchParams.set("desktop-surface", CONSOLE_SECTION_SURFACE);
      void contents.loadURL(url.toString()).catch((error: unknown) => { if (view === created) fail(String(error)); });
    } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  };

  return {
    attach(contents: WebContents) {
      sender = contents;
      contents.on("will-navigate", (event, url) => {
        let parsed: URL;
        try { parsed = new URL(url); } catch { return; }
        if (parsed.searchParams.get("desktop-surface") !== CONSOLE_SECTION_SIGNAL) return;
        event.preventDefault();
        // 활성 문서가 자기 origin에서 낸 신호만 받는다. 집의 목록·이름은 이 방향으로 오가지 않는다.
        if (parsed.origin !== currentOrigin() || !parsed.pathname.startsWith("/console/")) return;
        const signal = parseSignal(parsed);
        if (!signal) return;
        if (signal.hidden === true) { geometry = null; refresh(); return; }
        if (isConsoleSectionGeometry(signal.geometry)) { geometry = signal.geometry; ensure(); refresh(); if (failed) publishHeight(null); }
        if ((signal.focus === "first" || signal.focus === "last") && view && requestedHeight > 0) {
          view.webContents.focus();
          void dispatch(view.webContents, CONSOLE_SECTION_FOCUS_EVENT, signal.focus).catch(() => undefined);
        }
      });
      contents.on("did-navigate", () => { geometry = null; refresh(); });
      contents.on("render-process-gone", () => { geometry = null; refresh(); });
    },
    refresh,
    pickerClosed() {
      if (!view) return;
      void dispatch(view.webContents, CONSOLE_SECTION_REFRESH_EVENT, null).catch(() => undefined);
      if (geometry?.visible && requestedHeight > 0) {
        try { view.webContents.focus(); } catch { /* 창 종료 중에는 복귀할 포커스가 없다. */ }
      }
    },
    close() { geometry = null; sender = null; disposeView(); failed = false; },
  };
}

function parseSignal(url: URL): Record<string, unknown> | null {
  const text = url.searchParams.get("signal");
  if (!text || text.length > 4096) return null;
  try { const value: unknown = JSON.parse(text); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
}
