import path from "node:path";
import { pathToFileURL } from "node:url";
import type { BaseWindow, Rectangle, WebContents, WebContentsView } from "electron";
import type { DesktopBrowserChrome, DesktopBrowserSurface, DesktopBrowserSurfaceRelay } from "@fleet-console/protocol/desktop";

import { createBrowserSpaceView, type BrowserSpaceRequest } from "./browser-spaces.js";
import type { BrowserSurfaceHost, PageHost } from "./browser-views.js";
import { readChromeMessage, type ChromeAction, type ChromeColors, type ChromeControl, type ChromeOverlay, type ChromeRole, type ChromeTabsOrientation, type ChromeUiState, type ChromeViewOnly } from "./chrome/contract.js";
import type { BrowserStripPrefs } from "./desktop-state.js";
import type { DesktopShellWindow } from "./shell-window.js";

/** 상단 줄(주소줄)의 높이 — Console 대화 화면의 맨 위 줄(52px)과 같다. 레일·페이지는 그 아래에서 시작한다. */
export const BROWSER_STRIP_PX = 52;
export const BROWSER_RAIL_COLLAPSED_PX = 54;
export const BROWSER_RAIL_EXPANDED_PX = 237;
/** 가로 탭 표시줄의 높이 — 맨 위 줄이 되므로 주소줄과 같은 52px 이다(신호등·Windows 캡션 띠가 그 높이에 맞춰 서 있다). 주소줄은 그 아래로 내려간다. */
export const BROWSER_TABSTRIP_PX = BROWSER_STRIP_PX;
/** 알림이 떠 있는 동안 주소줄 뷰가 아래로 더 가지는 높이. */
const TOAST_BAND_PX = 52;
const DIVIDER_PX = 8;
const MIN_PANE_PX = 320;
/** 칸을 줄이더라도 Console 이 지키는 폭. */
const MIN_CONSOLE_PX = 600;
const MAC_TRAFFIC_LIGHTS_PX = 76;
const WINDOWS_CAPTION_PX = 138;
const WINDOW_FALLBACK_MS = 3_000;
const TOAST_MS = 4_000;
const TOAST_ACTION_MS = 8_000;
/** 페이지에서 대화상자가 뜬 뒤 Console 을 돌아 크롬에 카드가 서기까지 기다리는 한도. */
const DIALOG_FOCUS_WINDOW_MS = 5_000;
/** 가드 문서가 알약 크기를 알려 주기 전까지 쓰는 크기(CSS px)와, 알약 둘레에 그림자·아래 여백으로 더 잡는 자리. */
const GUARD_PILL_DEFAULT = { width: 420, height: 48 };
const GUARD_PILL_MARGIN_X = 24;
const GUARD_PILL_MARGIN_TOP = 24;
const GUARD_PILL_BOTTOM = 18;

/** 문서가 동작을 요청하는 경로의 반대쪽 — 동작 처리기가 표면을 고칠 때 쓰는 손잡이. */
export interface SurfaceControl {
  ui(): Readonly<SurfaceUi>;
  patch(change: Partial<SurfaceUi>): void;
  /** 알림 한 줄 — 오류(notice)면 빨강, 정보(info)면 동사가 붙을 수 있다. 일정 시간 뒤 거둔다. */
  notify(text: string | null, kind?: "info" | "error", action?: string): void;
  chrome(): DesktopBrowserChrome | null;
  surface(): DesktopBrowserSurface | null;
  /** 지금 화면에 띄운 스페이스 — 새 탭·주소·뷰포트 요청이 이 스페이스를 겨눈다. */
  space(): string;
  /** 사람이 고른 스페이스를 띄운다. 화면을 맞추려고 Console 에 보낼 요청을 돌려준다(없으면 null). */
  chooseSpace(spaceId: string): BrowserSpaceRequest | null;
  /** 주소줄 문서에 직접 호출을 보낸다(주석 요소 조회 답). */
  evaluate(role: ChromeRole, code: string): void;
  /** 키보드 초점을 그 크롬 문서의 뷰로 옮긴다. */
  focus(role: ChromeRole): void;
  /** 지금 화면의 제어권 — 에이전트가 표시 탭을 모는 중인지, 사람이 쥐었는지. 없으면 null. */
  control(): ChromeControl | null;
}

export interface SurfaceUi {
  pinned: boolean;
  expanded: boolean;
  orientation: ChromeTabsOrientation;
  autoExpand: boolean;
  overlay: ChromeOverlay | null;
  busy: boolean;
  notice: string | null;
  info: { text: string; action?: string } | null;
  suggest: ChromeUiState["suggest"];
  suggestions: ChromeUiState["suggestions"];
  draft: string | null;
  /** 가드 문서가 잰 제어 알약의 크기(CSS px). 아직 모르면 null. */
  guardPill: { width: number; height: number } | null;
}

export interface BrowserSurfaceDeps {
  readonly main: () => DesktopShellWindow | null;
  readonly createChromeView: () => WebContentsView;
  readonly createDividerView: () => WebContentsView;
  /** 독립 창 — 장식(신호등 위치·Windows 캡션 띠)까지 마친 BaseWindow. 닫으면 칸으로 돌아간다. */
  readonly createWindow: () => BaseWindow;
  readonly chromeDir: string;
  /** 크롬 문서에 주입하는 프로그램 본문. */
  readonly program: () => string;
  readonly colors: () => ChromeColors | null;
  readonly lang: "ko" | "en";
  readonly platform: string;
  readonly scaleFactor: (base: BaseWindow) => number;
  /** Console 창의 확대·축소 배율. 크롬 문서는 이 배율로 그려지고 줄·레일·알림 띠의 DIP 크기도 같은 배율을 따른다(Console 맨 위 줄이 확대되는 것처럼). */
  readonly zoom: () => number;
  /** 탭 표시줄의 고정·방향·자동 펼침 — 앱을 다시 켜도 남는다. 없으면 기억하지 않는다. */
  readonly stripPrefs?: { load(): BrowserStripPrefs | null; save(prefs: BrowserStripPrefs): void };
  /** 문서가 보낸 동작 하나를 처리한다. */
  readonly act: (control: SurfaceControl, role: ChromeRole, action: ChromeAction) => void;
  readonly relay: (surface: DesktopBrowserSurfaceRelay) => void;
  /** 페이지 자리가 바뀌었다 — browser-views 가 뷰를 같은 틱에 다시 놓는다. */
  readonly changed: () => void;
  readonly log: (message: string) => void;
}

interface ChromeDoc { readonly role: ChromeRole; readonly view: WebContentsView; ready: boolean; lastJson: string }

const escapeScript = (value: string): string => value.replace(/[<>&\u2028\u2029]/g, (character) => ({ "<": "\\u003c", ">": "\\u003e", "&": "\\u0026", "\u2028": "\\u2028", "\u2029": "\\u2029" })[character] ?? character);

/** 메인 창을 페이지 뷰의 집으로 보이는 어댑터 — Console 뒤에 주차하고, 표면이 칸이면 Console 앞(레일 아래)에 세운다. */
export function createMainPageHost(shell: DesktopShellWindow, scaleFactor: (base: BaseWindow) => number): PageHost {
  return {
    isDestroyed: () => shell.isDestroyed(),
    contentBounds: () => shell.stack.layoutConsole(),
    park: (view) => shell.stack.parkBrowser(view),
    present: (view) => shell.stack.presentBrowser(view),
    remove: (view) => shell.stack.removeBrowser(view),
    scale: () => scaleFactor(shell.base),
    reclaimFocus: () => shell.consoleContents.focus(),
  };
}

/**
 * 브라우저 표면 — 칸(메인 창 오른쪽)과 독립 창을 같은 구조로 소유한다: 상단 줄 뷰·세로 레일 뷰·페이지 뷰. 레이아웃·오버레이 크기·페이지 자리는
 * 전부 여기서 같은 main 틱에 정한다. Console 은 상태와 정책만 보내고(스냅샷), 이 표면은 사람의 동작을 REST 로 돌려보낸다.
 */
export function createBrowserSurface(deps: BrowserSurfaceDeps): BrowserSurfaceHost & { relay(surface: DesktopBrowserSurfaceRelay): void; retheme(): void; conceal(): void; captionInset(kind: "pane" | "window"): number; viewing(): boolean; frame(tabId: string, jpeg: Buffer): void } {
  type Docs = { bar: ChromeDoc; rail: ChromeDoc; stage: ChromeDoc; guard: ChromeDoc };
  let surface: DesktopBrowserSurface | null = null;
  let chrome: DesktopBrowserChrome | null = null;
  let chromeJson = "";
  /** 보기 전용 셸인가 — 이 Desktop 이 관리하지 않는 Console 의 브라우저를 보기만 한다. 페이지 뷰도 가드도 서지 않는다. */
  let viewOnly: ChromeViewOnly | null = null;
  let docs: Docs | null = null;
  let divider: WebContentsView | null = null;
  let windowBase: BaseWindow | null = null;
  let windowStack: ReturnType<typeof createWindowStack> | null = null;
  let host: PageHost | null = null;
  let hostKind: "pane" | "window" | null = null;
  let page: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  let paneWidth = 560;
  const remembered = deps.stripPrefs?.load() ?? null;
  let ui: SurfaceUi = { pinned: remembered?.pinned ?? false, expanded: false, orientation: remembered?.orientation ?? "vertical", autoExpand: remembered?.autoExpand ?? true, overlay: null, busy: false, notice: null, info: null, suggest: null, suggestions: [], draft: null, guardPill: null };
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let focusSeen = 0;
  let closing: ReturnType<typeof setTimeout> | null = null;
  let drag: { screenX: number; width: number } | null = null;
  let appliedZoom = 1;
  /** 표면이 닫혀도 남는다 — 닫힌 동안 만들어지는 뷰가 마지막 페이지 크기를 따르게. */
  let lastPageSize: { width: number; height: number } | null = null;
  /** 어느 스페이스를 보여 주는가 — 표면이 닫혀도 남는다. 다시 열면 보던 스페이스에서 이어진다. */
  const spaces = createBrowserSpaceView();

  const surfaceRect = (): Rectangle | null => {
    if (hostKind === "pane") {
      const main = deps.main();
      if (!main || main.isDestroyed()) return null;
      const content = main.getContentBounds();
      // Console 은 600 DIP 를 먼저 지킨다. 창이 좁아질 때 선호 폭을 덮어쓰지 않고 칸부터 줄인다.
      const width = Math.min(Math.max(MIN_PANE_PX, paneWidth), Math.max(1, content.width - MIN_CONSOLE_PX - DIVIDER_PX));
      const left = Math.max(1, content.width - width - DIVIDER_PX);
      return { x: left + DIVIDER_PX, y: 0, width, height: Math.max(1, content.height) };
    }
    if (hostKind === "window" && windowBase && !windowBase.isDestroyed()) {
      const content = windowBase.getContentBounds();
      return { x: 0, y: 0, width: Math.max(1, content.width), height: Math.max(1, content.height) };
    }
    return null;
  };

  const zoom = (): number => { const z = deps.zoom(); return Number.isFinite(z) && z >= 0.25 && z <= 5 ? z : 1; };
  /** CSS px(크롬 문서의 치수)를 DIP 로. */
  const dip = (cssPx: number): number => Math.round(cssPx * zoom());
  const stripPx = (): number => dip(BROWSER_STRIP_PX);
  const horizontal = (): boolean => ui.orientation === "horizontal";
  /** 주소줄 위에 서는 가로 탭 표시줄의 높이 — 세로 레일이면 0. */
  const tabsPx = (): number => (horizontal() ? dip(BROWSER_TABSTRIP_PX) : 0);
  const railWidth = (): number => dip(ui.pinned || ui.expanded ? BROWSER_RAIL_EXPANDED_PX : BROWSER_RAIL_COLLAPSED_PX);
  /** 페이지 왼쪽을 차지하는 레일 폭 — 호버 펼침은 페이지 위에 겹칠 뿐 자리를 밀지 않고, 가로 표시줄이면 0. */
  const layoutRailWidth = (): number => (horizontal() ? 0 : dip(ui.pinned ? BROWSER_RAIL_EXPANDED_PX : BROWSER_RAIL_COLLAPSED_PX));
  // 표시 탭의 alert·confirm 은 페이지 자리를 덮어 그린다 — 페이지는 크롬 문서 아래의 네이티브 뷰라, 문서 뷰를 키워야 그 위에 보인다.
  const pageDialog = (): boolean => chrome?.tabs.some((tab) => tab.id === chrome?.activeTabId && tab.dialog !== undefined) === true;
  // 페이지에 초점이 있던 사람의 대화상자는 카드가 서는 순간 크롬으로 초점을 옮긴다. 늦게 오는 다른 대화상자가 이 요청을 쓰지 않게 잠깐만 유효하다.
  let dialogFocusAt = 0;
  let dialogFocusToken = 0;
  const takeDialogFocus = (): boolean => {
    if (!docs || !pageDialog() || Date.now() - dialogFocusAt > DIALOG_FOCUS_WINDOW_MS) return false;
    dialogFocusAt = 0;
    dialogFocusToken += 1;
    if (!docs.bar.view.webContents.isDestroyed()) docs.bar.view.webContents.focus();
    return true;
  };
  /** 주소줄 뷰의 높이 — 그 뷰는 `top`(가로 탭 표시줄) 아래에서 시작한다. */
  const barHeight = (rect: Rectangle, top: number): number => { const room = Math.max(1, rect.height - top); return ui.overlay !== null || pageDialog() ? room : ui.notice || ui.info ? Math.min(room, stripPx() + dip(TOAST_BAND_PX)) : Math.min(room, stripPx()); };

  const allDocs = (set: Docs): ChromeDoc[] => [set.bar, set.rail, set.stage, set.guard];

  /**
   * 지금 화면의 제어권. 사람이 쥔 스페이스를 보고 있으면 어느 탭에서든 `user` 다 — 돌려줄 단추가 늘 손에 닿아야 한다.
   * `agent` 는 보는 탭이 그 스페이스 에이전트의 작업 탭이고 에이전트가 쓰는 중일 때뿐이다. 사람이 연 다른 탭은 잠기지 않는다.
   */
  const controlState = (): ChromeControl | null => {
    if (!chrome || !chrome.available || viewOnly) return null;
    const space = chrome.spaces.find((candidate) => candidate.id === spaces.current());
    // 제어권을 모르는 Console(이 필드가 없는 옛 투영)에서는 가드를 세우지 않는다 — 풀어 줄 길(제어 요청 경로)이 그쪽에 없어 잠그면 사람이 그 탭을 쓸 수 없게 된다.
    if (!space || space.control === undefined) return null;
    if (space.control === "user") return { holder: "user", spaceId: space.id, reason: space.attention?.reason ?? null, pointer: null };
    const tabId = chrome.activeTabId;
    if (!space.driving || tabId === null || !space.agentTabIds.includes(tabId)) return null;
    const z = zoom();
    const pointer = space.pointer && space.pointer.tabId === tabId ? { x: space.pointer.x / z, y: space.pointer.y / z, kind: space.pointer.kind, seq: space.pointer.seq, actor: space.pointer.actor ?? "" } : null;
    return { holder: "agent", spaceId: space.id, reason: null, pointer };
  };

  const heldKey = (): string => { const held = controlState(); return held ? `${held.holder}:${held.spaceId}` : ""; };
  let heldSeen = "";

  /** 가드 뷰의 자리 — 에이전트가 모는 중이면 페이지 전체(사람의 포인터가 페이지에 닿지 않는다), 사람이 쥐었으면 아래 가운데 알약 자리뿐이다. */
  const guardBounds = (control: ChromeControl): Rectangle => {
    if (control.holder === "agent") return { x: page.x, y: page.y, width: Math.max(1, page.width), height: Math.max(1, page.height) };
    const pill = ui.guardPill ?? GUARD_PILL_DEFAULT;
    const width = Math.max(1, Math.min(page.width, dip(pill.width + GUARD_PILL_MARGIN_X * 2)));
    const height = Math.max(1, Math.min(page.height, dip(pill.height + GUARD_PILL_BOTTOM + GUARD_PILL_MARGIN_TOP)));
    return { x: page.x + Math.round((page.width - width) / 2), y: page.y + page.height - height, width, height };
  };

  /** 모든 뷰의 자리를 같은 틱에 정한다. 상태 문서에 알리는 것은 이 뒤다 — 뷰 크기와 문서 레이아웃이 어긋난 프레임이 없게. */
  const layout = (): void => {
    if (!docs) return;
    const rect = surfaceRect();
    if (!rect) return;
    const z = zoom();
    if (z !== appliedZoom) { appliedZoom = z; for (const doc of allDocs(docs)) if (!doc.view.webContents.isDestroyed()) doc.view.webContents.setZoomFactor(z); }
    const top = Math.min(tabsPx(), rect.height);
    const strip = Math.min(stripPx(), Math.max(0, rect.height - top));
    const side = layoutRailWidth();
    page = { x: rect.x + Math.min(side, rect.width), y: rect.y + top + strip, width: Math.max(0, rect.width - side), height: Math.max(0, rect.height - top - strip) };
    if (page.width > 0 && page.height > 0) lastPageSize = { width: page.width, height: page.height };
    docs.bar.view.setBounds({ x: rect.x, y: rect.y + top, width: rect.width, height: barHeight(rect, top) });
    // 탭 표시줄 뷰 — 세로면 주소줄 아래 왼쪽의 레일, 가로면 주소줄 위의 한 줄이다. 같은 문서가 두 모양을 그린다.
    docs.rail.view.setBounds(horizontal()
      ? { x: rect.x, y: rect.y, width: rect.width, height: Math.max(1, top) }
      : { x: rect.x, y: rect.y + strip, width: Math.min(railWidth(), rect.width), height: Math.max(1, rect.height - strip) });
    docs.stage.view.setBounds({ x: page.x, y: page.y, width: Math.max(1, page.width), height: Math.max(1, page.height) });
    // 가드는 제어권이 걸린 동안만 선다 — 그 밖에는 숨겨서 페이지가 포인터를 그대로 받는다.
    const held = page.width > 0 && page.height > 0 ? controlState() : null;
    if (held) docs.guard.view.setBounds(guardBounds(held));
    docs.guard.view.setVisible(held !== null);
    // 대화상자 카드는 주소줄 문서가 페이지 자리를 덮어 그린다 — 그동안은 가드를 그 위로 올려 제어 알약이 보이고 눌리게 한다.
    // 에이전트가 모는 중이면 가드가 카드도 덮어, 사람의 포인터가 잠긴 페이지의 대화상자에 닿지 않는다.
    const guardOnTop = held !== null && ui.overlay === null && pageDialog();
    if (hostKind === "window") windowStack?.raiseGuard(guardOnTop);
    if (hostKind === "pane") {
      const main = deps.main();
      if (main && !main.isDestroyed() && divider) {
        const left = rect.x - DIVIDER_PX;
        main.stack.setBrowserPane({ stage: docs.stage.view, guard: docs.guard.view, rail: docs.rail.view, bar: docs.bar.view, divider, consoleWidth: left, guardOnTop });
        divider.setBounds({ x: left, y: 0, width: DIVIDER_PX, height: rect.height });
      }
    }
    deps.changed();
  };

  const state = (): ChromeUiState => {
    const rect = surfaceRect();
    const z = zoom();
    const leading = hostKind === "window" && deps.platform === "darwin" ? MAC_TRAFFIC_LIGHTS_PX / z : 0;
    const trailing = deps.platform === "win32" ? WINDOWS_CAPTION_PX / z : 0;
    return {
      lang: deps.lang, platform: deps.platform, mode: surface?.mode ?? "pane", colors: deps.colors(), chrome, spaceId: spaces.current(), pinned: ui.pinned, expanded: ui.expanded,
      orientation: ui.orientation, autoExpand: ui.autoExpand,
      leading, trailing,
      // 주소줄 뷰 기준이다 — 가로 탭 표시줄은 그 뷰 위에 따로 서므로 여기 높이에서 빠진다.
      page: rect ? { x: layoutRailWidth() / z, y: Math.min(stripPx(), Math.max(0, rect.height - tabsPx())) / z, width: Math.max(0, rect.width - layoutRailWidth()) / z, height: Math.max(0, rect.height - tabsPx() - stripPx()) / z } : { x: 0, y: 0, width: 0, height: 0 },
      zoom: z, busy: ui.busy, notice: ui.notice, info: ui.info, overlay: ui.overlay, overlayReady: ui.overlay !== null, pageDialogFocus: dialogFocusToken,
      suggest: ui.suggest, suggestions: ui.suggestions, captureAvailable: true, importUnavailable: deps.platform === "win32", draft: ui.draft,
      control: controlState(),
      viewOnly,
    };
  };

  let dividerScheme = "";
  const push = (): void => {
    if (!docs) return;
    // 손잡이 문서는 상태를 받지 않는다 — 색 구성표만 Console 테마에 맞춘다(그 문서의 light-dark() 가 이 값을 읽는다).
    const scheme = deps.colors()?.scheme ?? "";
    if (divider && scheme && scheme !== dividerScheme && !divider.webContents.isDestroyed()) { dividerScheme = scheme; void divider.webContents.executeJavaScript(`document.documentElement.style.colorScheme = ${JSON.stringify(scheme)}`).catch(() => undefined); }
    const json = escapeScript(JSON.stringify(state()));
    for (const doc of allDocs(docs)) {
      if (!doc.ready || doc.view.webContents.isDestroyed() || doc.lastJson === json) continue;
      doc.lastJson = json;
      void doc.view.webContents.executeJavaScript(`window.__fleetChrome && window.__fleetChrome.apply(${json})`).catch(() => undefined);
    }
  };

  const update = (): void => { layout(); push(); };

  const control: SurfaceControl = {
    ui: () => ui,
    patch(change) {
      const before = ui;
      ui = { ...ui, ...change };
      if (ui.pinned !== before.pinned || ui.orientation !== before.orientation || ui.autoExpand !== before.autoExpand) deps.stripPrefs?.save({ pinned: ui.pinned, orientation: ui.orientation, autoExpand: ui.autoExpand });
      update();
    },
    notify(text, kind = "info", action) {
      if (toastTimer !== null) { clearTimeout(toastTimer); toastTimer = null; }
      if (!text) { ui = { ...ui, notice: null, info: null }; update(); return; }
      ui = kind === "error" ? { ...ui, notice: text, info: null } : { ...ui, notice: null, info: { text, ...(action ? { action } : {}) } };
      update();
      toastTimer = setTimeout(() => { toastTimer = null; ui = { ...ui, notice: null, info: null }; update(); }, action ? TOAST_ACTION_MS : TOAST_MS);
    },
    chrome: () => chrome,
    surface: () => surface,
    space: () => spaces.current(),
    chooseSpace(spaceId) { const request = spaces.choose(spaceId, chrome); update(); return request; },
    evaluate(role, code) {
      const doc = docs?.[role];
      if (doc && doc.ready && !doc.view.webContents.isDestroyed()) void doc.view.webContents.executeJavaScript(code).catch(() => undefined);
    },
    focus(role) {
      const doc = docs?.[role];
      if (doc && !doc.view.webContents.isDestroyed()) doc.view.webContents.focus();
    },
    control: controlState,
  };

  const isTrusted = (doc: ChromeDoc, details: { frame: { url: string } | null }): boolean => {
    const contents = doc.view.webContents;
    return details.frame !== null && details.frame === contents.mainFrame && details.frame.url === pathToFileURL(path.join(deps.chromeDir, `${doc.role}.html`)).href;
  };

  const makeDoc = (role: ChromeRole): ChromeDoc => {
    const view = deps.createChromeView();
    const contents: WebContents = view.webContents;
    const doc: ChromeDoc = { role, view, ready: false, lastJson: "" };
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("console-message", (details: { message: string; frame: { url: string } | null }) => {
      if (docs?.[role] !== doc || !isTrusted(doc, details)) return;
      const message = readChromeMessage(details.message);
      if (!message || message.role !== role) return;
      if (message.action.action === "ready") { doc.ready = true; doc.lastJson = ""; push(); return; }
      deps.act(control, role, message.action);
    });
    // 문서를 적재하면 배율이 1로 돌아간다 — 적재 전에 건 배율은 남지 않으므로, 문서가 준비될 때마다 현재 배율을 다시 건다.
    contents.on("dom-ready", () => { doc.ready = false; appliedZoom = zoom(); contents.setZoomFactor(appliedZoom); void contents.executeJavaScript(deps.program()).catch((error: unknown) => deps.log(`browser chrome program failed: ${error instanceof Error ? error.message : "unknown"}`)); });
    contents.on("render-process-gone", () => { doc.ready = false; void contents.reload(); });
    view.setBackgroundColor("#00000000");
    void contents.loadFile(path.join(deps.chromeDir, `${role}.html`)).catch(() => undefined);
    return doc;
  };

  const attachPaneDivider = (): void => {
    if (!divider) return;
    const view = divider;
    const contents = view.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("console-message", (details: { message: string; frame: { url: string } | null }) => {
      // 이 수동 문서의 고정 frame만 읽는다. Console/페이지 로그는 이 listener에 연결되지 않는다.
      if (divider !== view || details.frame !== contents.mainFrame || details.frame.url !== DIVIDER_URL) return;
      let value: unknown;
      try { value = JSON.parse(details.message); } catch { return; }
      if (!Array.isArray(value) || value[0] !== "fleet-pane" || value.length !== 3) return;
      const [, action, x] = value;
      if (typeof x !== "number" || !Number.isFinite(x)) return;
      const main = deps.main();
      if (!main || main.isDestroyed()) return;
      const current = surfaceRect();
      if (!current) return;
      const limit = (width: number): number => Math.max(MIN_PANE_PX, Math.min(main.getContentBounds().width - MIN_CONSOLE_PX - DIVIDER_PX, width));
      if (action === "start") drag = { screenX: x, width: current.width };
      else if (action === "move" && drag) { paneWidth = limit(drag.width + drag.screenX - x); update(); }
      else if (action === "end") drag = null;
      else if (action === "key") { paneWidth = limit(current.width + x); update(); }
    });
    contents.on("did-finish-load", () => { dividerScheme = ""; push(); });
    void contents.loadURL(DIVIDER_URL).catch(() => undefined);
  };

  const detachFromHost = (): void => {
    if (!docs) return;
    if (hostKind === "pane") { const main = deps.main(); if (main && !main.isDestroyed()) main.stack.setBrowserPane(null); }
    if (hostKind === "window") { windowStack?.clear(); }
    host = null; hostKind = null;
  };

  const destroyWindow = (): void => {
    const base = windowBase;
    windowBase = null; windowStack = null;
    if (closing !== null) { clearTimeout(closing); closing = null; }
    if (base && !base.isDestroyed()) { base.removeAllListeners("close"); base.destroy(); }
  };

  const makeWindow = (): void => {
    const base = deps.createWindow();
    windowBase = base;
    windowStack = createWindowStack(base);
    const own = (): boolean => windowBase === base;
    base.on("resize", () => { if (own()) update(); });
    base.on("move", () => { if (own()) deps.changed(); });
    base.on("minimize", () => { if (own()) deps.changed(); });
    base.on("restore", () => { if (own()) deps.changed(); });
    // 창 닫기는 칸으로 돌아가라는 뜻이다. 모드는 Console 이 쥐고 있으므로 요청하고, 돌아오지 않으면 표면을 놓는다.
    base.on("close", (event) => {
      if (!own()) return;
      event.preventDefault();
      if (closing !== null) return;
      const current = surface;
      if (current) deps.act(control, "bar", { action: "toggle-mode" });
      closing = setTimeout(() => { closing = null; if (own() && surface?.id === current?.id && surface?.mode === "window" && current) { deps.relay({ id: current.id, status: "closed" }); } }, WINDOW_FALLBACK_MS);
    });
    base.on("closed", () => { if (windowBase === base) { windowBase = null; windowStack = null; if (docs && surface?.mode === "window") deps.relay({ id: surface.id, status: "closed" }); } });
  };

  /** 표면의 모드(칸/창)에 맞는 집에 크롬 뷰를 세운다. 같은 두 뷰를 옮길 뿐 문서를 다시 만들지 않는다. */
  const ensureHost = (next: DesktopBrowserSurface): void => {
    if (!docs) return;
    if (hostKind === next.mode) return;
    detachFromHost();
    if (next.mode === "pane") {
      const main = deps.main();
      if (!main || main.isDestroyed()) return;
      if (!divider) { divider = deps.createDividerView(); attachPaneDivider(); }
      hostKind = "pane";
      host = createMainPageHost(main, deps.scaleFactor);
      destroyWindow();
    } else {
      if (!windowBase || windowBase.isDestroyed()) makeWindow();
      hostKind = "window";
      windowStack!.set(docs.stage.view, docs.guard.view, docs.rail.view, docs.bar.view);
      host = windowStack!.host(() => deps.scaleFactor(windowBase!), () => { if (docs && !docs.bar.view.webContents.isDestroyed()) docs.bar.view.webContents.focus(); });
      if (windowBase && !windowBase.isDestroyed()) { windowBase.show(); }
    }
    update();
  };

  /**
   * 표면을 거둔다 — 뷰·창·타이머를 놓고 다음 `apply` 가 처음부터 다시 세울 수 있게 비운다.
   * 열린 표면 lease 를 closed 로 보고하지는 않는다. 창을 접는 요청만 그 보고를 한다.
   */
  const closeSurface = (): void => {
    if (!surface && !docs) return;
    if (toastTimer !== null) { clearTimeout(toastTimer); toastTimer = null; }
    const old = docs;
    detachFromHost();
    destroyWindow();
    const oldDivider = divider;
    docs = null; divider = null; surface = null; chrome = null; chromeJson = ""; viewOnly = null; focusSeen = 0; drag = null; heldSeen = "";
    spaces.observe(null);
    for (const view of [old?.bar.view, old?.rail.view, old?.stage.view, old?.guard.view, oldDivider]) { if (view && !view.webContents.isDestroyed()) { try { view.webContents.close(); } catch { /* 이미 닫혔다. */ } } }
    ui = { ...ui, expanded: false, overlay: null, busy: false, notice: null, info: null, suggestions: [], draft: null, guardPill: null };
    page = { x: 0, y: 0, width: 0, height: 0 };
    deps.changed();
  };

  return {
    apply(next, nextChrome, _origin, nextViewOnly = null) {
      if (!next) { closeSurface(); return; }
      const first = surface?.id !== next.id;
      if (first && docs) closeSurface();
      const viewChanged = JSON.stringify(viewOnly) !== JSON.stringify(nextViewOnly);
      viewOnly = nextViewOnly;
      surface = next;
      if (!docs) { docs = { bar: makeDoc("bar"), rail: makeDoc("rail"), stage: makeDoc("stage"), guard: makeDoc("guard") }; }
      const json = JSON.stringify(nextChrome);
      const chromeChanged = json !== chromeJson;
      const dialogBefore = pageDialog();
      chrome = nextChrome; chromeJson = json;
      // 표시 스페이스는 여기서 정한다 — 표시 탭이 다른 스페이스로 옮겨 갔으면 따라가고, 화면이 어긋나 있으면 맞춰 달라고 요청한다.
      const spaceBefore = spaces.current();
      const request = chromeChanged ? spaces.observe(nextChrome) : null;
      ensureHost(next);
      if (hostKind === null) return;
      if (next.mode === "window" && (next.focusRequest ?? 0) > focusSeen && windowBase && !windowBase.isDestroyed()) {
        focusSeen = next.focusRequest ?? 0;
        if (windowBase.isMinimized()) windowBase.restore();
        windowBase.show(); windowBase.focus();
      } else if ((next.focusRequest ?? 0) > focusSeen) { focusSeen = next.focusRequest ?? 0; docs.bar.view.webContents.focus(); }
      // 대화상자가 뜨고 질 때는 크롬 문서의 높이도 바뀐다.
      const dialogChanged = pageDialog() !== dialogBefore;
      if (dialogChanged) takeDialogFocus();
      // 제어권이 바뀌었으면 가드의 자리를 같은 틱에 다시 정한 뒤 문서에 알린다. 포인터만 움직인 투영은 자리를 건드리지 않는다.
      const heldNow = heldKey();
      if (heldNow !== heldSeen || dialogChanged) { heldSeen = heldNow; update(); }
      else if (chromeChanged || viewChanged || spaces.current() !== spaceBefore) push();
      else layout();
      if (request) deps.act(control, "bar", { action: "show-tab", id: request.kind === "select" ? request.tabId : null });
    },
    target() {
      // 보기 전용 셸에는 페이지 뷰가 서지 않는다.
      return host && !host.isDestroyed() && page.width > 0 && !viewOnly ? { host, page: { ...page } } : null;
    },
    viewing: () => docs !== null && viewOnly !== null,
    /** 보기 전용 셸의 스테이지에 그 탭의 최신 프레임을 그린다. 스테이지 문서가 보는 탭의 것인지 한 번 더 가린다. */
    frame(tabId, jpeg) {
      const stage = docs?.stage;
      if (!viewOnly || !stage || !stage.ready || stage.view.webContents.isDestroyed()) return;
      void stage.view.webContents.executeJavaScript(`window.__fleetChrome && window.__fleetChrome.frame && window.__fleetChrome.frame(${JSON.stringify(tabId)}, ${JSON.stringify(`data:image/jpeg;base64,${jpeg.toString("base64")}`)})`).catch(() => undefined);
    },
    refresh() { if (docs) update(); },
    lastPage: () => (lastPageSize ? { ...lastPageSize } : null),
    focusPageDialog() { dialogFocusAt = Date.now(); if (takeDialogFocus()) update(); },
    dispose: closeSurface,
    /** 창이 다른 콘솔을 보는 동안 네이티브 표면만 내린다. 서버의 표면 lease 는 그대로 둔다. */
    conceal: closeSurface,
    relay: (value) => deps.relay(value),
    // Console 테마(라이트·다크·시스템)가 바뀌었다 — 새로고침 없이 크롬 문서와 손잡이가 같은 순간 새 색으로 다시 칠해진다.
    retheme() { if (docs) push(); },
    // Windows 캡션 버튼이 이 표면의 맨 위 줄에 설 때, 그 줄이 주소줄이면 아래 구분선(1 CSS px)만큼 캡션 띠를 낮춘다. 가로 탭 표시줄은 아래 선이 없어 덜지 않는다.
    // 에이전트가 표시 탭을 모는 동안에는 사람의 키보드도 그 페이지에 닿지 않아야 한다 — browser-views 가 이 값으로 키 입력을 막고 초점을 거둔다.
    inputLocked: () => controlState()?.holder === "agent",
    captionInset: (kind) => (docs && hostKind === kind && !horizontal() ? Math.max(1, Math.round(zoom())) : 0),
  };
}

/** 독립 창의 뷰 쌓기 — 표시 중인 페이지 뷰 < 가드 < 레일 < 주소줄. 이 창에는 Console 도 주차된 뷰도 없다. */
function createWindowStack(base: BaseWindow) {
  const presented = new Set<WebContentsView>();
  let stage: WebContentsView | null = null;
  let guard: WebContentsView | null = null;
  let rail: WebContentsView | null = null;
  let bar: WebContentsView | null = null;
  let guardOnTop = false;
  const relayout = (): void => {
    const chromeViews = [...(rail ? [rail] : []), ...(bar ? [bar] : [])];
    const ordered = [...(stage ? [stage] : []), ...presented, ...(guard && !guardOnTop ? [guard] : []), ...chromeViews, ...(guard && guardOnTop ? [guard] : [])];
    for (let index = 0; index < ordered.length; index += 1) base.contentView.addChildView(ordered[index]!, index);
  };
  const remove = (view: WebContentsView): void => { presented.delete(view); try { base.contentView.removeChildView(view); } catch { /* 이미 떨어졌다. */ } };
  return {
    set(nextStage: WebContentsView, nextGuard: WebContentsView, nextRail: WebContentsView, nextBar: WebContentsView): void { stage = nextStage; guard = nextGuard; rail = nextRail; bar = nextBar; relayout(); },
    /** 대화상자 카드가 떠 있는 동안 가드를 주소줄 위로 올린다 — 바뀔 때만 다시 쌓는다. */
    raiseGuard(on: boolean): void { if (on === guardOnTop) return; guardOnTop = on; relayout(); },
    clear(): void { for (const view of [stage, guard, rail, bar]) if (view) { try { base.contentView.removeChildView(view); } catch { /* 이미 떨어졌다. */ } } stage = null; guard = null; rail = null; bar = null; guardOnTop = false; },
    host(scale: () => number, focus: () => void): PageHost {
      return {
        isDestroyed: () => base.isDestroyed(),
        contentBounds: () => { const { width, height } = base.getContentBounds(); return { x: 0, y: 0, width: Math.max(1, width), height: Math.max(1, height) }; },
        park: remove,
        present: (view) => { if (presented.has(view)) return; presented.add(view); relayout(); },
        remove,
        scale,
        reclaimFocus: focus,
      };
    },
  };
}

// 셸의 수동 문서는 Node·주입 스크립트·IPC 없이 pointer capture와 진단 이벤트만 쓴다.
const DIVIDER_HTML = `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;user-select:none;cursor:col-resize;background:light-dark(#e4e4e5,#202023)}
body{box-sizing:border-box;border-left:1px solid light-dark(#c8c8ca,#39393e);border-right:1px solid light-dark(#c8c8ca,#39393e);box-shadow:inset 2px 0 4px #0002;touch-action:none}
body:hover,body:focus-visible{background:light-dark(#d2d2d5,#35353b);outline:none}
</style><body role="separator" aria-label="Resize browser pane" aria-orientation="vertical" tabindex="0"><script>
const send=(action,x)=>console.log(JSON.stringify(['fleet-pane',action,x]));
let pointer=null;
addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();document.body.setPointerCapture(e.pointerId);pointer=e.pointerId;send('start',e.screenX)});
addEventListener('pointermove',e=>{if(pointer===e.pointerId)send('move',e.screenX)});
const end=e=>{if(pointer!==e.pointerId)return;pointer=null;send('end',e.screenX)};
addEventListener('pointerup',end);addEventListener('pointercancel',end);addEventListener('lostpointercapture',end);
addEventListener('keydown',e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();send('key',(e.key==='ArrowLeft'?1:-1)*(e.shiftKey?64:16))}});
</script>`;
const DIVIDER_URL = `data:text/html;charset=utf-8,${encodeURIComponent(DIVIDER_HTML)}`;
