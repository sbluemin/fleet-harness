import type { BaseWindow, Rectangle, TitleBarOverlayOptions, WebContents, WebContentsView } from "electron";

import type { DesktopFullscreenWindow } from "./desktop-fullscreen-sync.js";

/**
 * Fleet Desktop 의 창 골격 — BaseWindow 와 Console WebContentsView 를 한 몸으로 다룬다.
 *
 * BrowserWindow 의 내장 webContents 는 다른 WebContentsView 로 옮길 수 없다(already attached).
 * Console 은 명시적인 WebContentsView 로만 그리고, Operation 브라우저 뷰는 형제로 쌓는다.
 * Operation Browser 실험에서는 macOS CDP 가 hidden/0×0 에서 불안정해 보였으므로, 네이티브 뷰는
 * visible=true·nonzero bounds 를 유지하고 사용자 노출은 z-order(parking) 로 구분한다.
 */

export interface DesktopViewStack {
  readonly consoleView: WebContentsView;
  /** Console 이 전체 콘텐츠 영역을 불투명하게 덮도록 bounds 를 맞춘다. */
  layoutConsole(): Rectangle;
  /** CDP 는 살아 있지만 Console 뒤에 둔다 — 입력이 새어 나가지 않게 Console 이 위에 있다. */
  parkBrowser(view: WebContentsView): void;
  /** Console 앞, picker 아래 — 사용자가 보고 만지는 자리. */
  presentBrowser(view: WebContentsView): void;
  removeBrowser(view: WebContentsView): void;
  /** 호스트 목록 덮개 — 종료 인사 아래 최상단. */
  presentPicker(view: WebContentsView): void;
  removePicker(view: WebContentsView): void;
  /** 종료 인사 — 모든 뷰 위. 떠나는 창에서는 무엇도 그 앞에 서지 않는다. */
  presentVeil(view: WebContentsView): void;
  removeVeil(view: WebContentsView): void;
  /**
   * 콘솔 전환 덮개. 창과 함께 붙여 Console 뒤에 세워 둔다 — 새로 붙인 뷰는 첫 합성 프레임까지 1초 가까이
   * 걸리므로, 전환 순간에 만들면 덮개가 서기도 전에 문서가 바뀐다. 올리면 덮개는 picker 위, 종료 인사 아래에 선다.
   */
  mountSwitchVeil(view: WebContentsView): void;
  raiseSwitchVeil(): void;
  lowerSwitchVeil(): void;
  unmountSwitchVeil(): void;
}

export interface DesktopShellWindow {
  readonly base: BaseWindow;
  readonly consoleView: WebContentsView;
  /** Console 렌더러 — secure policy·remote bridge·capture·handoff 가 붙는 명시적 의존성. */
  readonly consoleContents: WebContents;
  readonly stack: DesktopViewStack;
  /** launch-controller 호환 — consoleContents 와 같다. */
  readonly webContents: WebContents;
  isDestroyed(): boolean;
  show(): void;
  hide(): void;
  focus(): void;
  isMinimized(): boolean;
  restore(): void;
  getBounds(): Rectangle;
  getContentBounds(): Rectangle;
  getMediaSourceId(): string;
  isFullScreen(): boolean;
  loadURL(url: string): Promise<void>;
  loadFile(path: string): Promise<void>;
  setWindowButtonPosition(position: { x: number; y: number } | null): void;
  setTitleBarOverlay(options: TitleBarOverlayOptions): void;
}

export function createDesktopViewStack(base: BaseWindow, consoleView: WebContentsView): DesktopViewStack {
  const parked = new Set<WebContentsView>();
  const presented = new Set<WebContentsView>();
  let picker: WebContentsView | null = null;
  let veil: WebContentsView | null = null;
  let switchVeil: WebContentsView | null = null;
  let switchVeilRaised = false;

  /** 이미 붙은 뷰는 remove 없이 addChildView(index) 로만 재정렬한다 — CDP 스냅샷마다 renderer churn 을 막는다. */
  const relayout = (): void => {
    const root = base.contentView;
    const ordered: WebContentsView[] = [];
    if (switchVeil && !switchVeilRaised) ordered.push(switchVeil);
    ordered.push(...parked, consoleView, ...presented);
    if (picker) ordered.push(picker);
    if (switchVeil && switchVeilRaised) ordered.push(switchVeil);
    if (veil) ordered.push(veil);
    for (let index = 0; index < ordered.length; index++) root.addChildView(ordered[index]!, index);
  };

  const layoutConsole = (): Rectangle => {
    const { width, height } = base.getContentBounds();
    const bounds = { x: 0, y: 0, width: Math.max(1, width), height: Math.max(1, height) };
    consoleView.setBounds(bounds);
    // 덮개는 Console과 한 치도 어긋나지 않아야 한다 — 스냅샷을 제자리에 겹쳐 그리기 때문이다.
    switchVeil?.setBounds(bounds);
    return bounds;
  };

  const parkBrowser = (view: WebContentsView): void => {
    if (parked.has(view) && !presented.has(view)) return;
    presented.delete(view);
    parked.add(view);
    relayout();
  };

  const presentBrowser = (view: WebContentsView): void => {
    if (presented.has(view) && !parked.has(view)) return;
    parked.delete(view);
    presented.add(view);
    relayout();
  };

  const removeBrowser = (view: WebContentsView): void => {
    parked.delete(view);
    presented.delete(view);
    try { base.contentView.removeChildView(view); } catch { /* 이미 떨어졌다. */ }
  };

  const presentPickerView = (view: WebContentsView): void => {
    if (picker === view) return;
    picker = view;
    relayout();
  };

  const removePickerView = (view: WebContentsView): void => {
    if (picker === view) picker = null;
    try { base.contentView.removeChildView(view); } catch { /* 이미 떨어졌다. */ }
    relayout();
  };

  const presentVeilView = (view: WebContentsView): void => {
    if (veil === view) return;
    veil = view;
    relayout();
  };

  const removeVeilView = (view: WebContentsView): void => {
    if (veil === view) veil = null;
    try { base.contentView.removeChildView(view); } catch { /* 이미 떨어졌다. */ }
  };

  const mountSwitchVeil = (view: WebContentsView): void => {
    if (switchVeil === view) return;
    switchVeil = view;
    switchVeilRaised = false;
    layoutConsole();
    relayout();
  };

  const raiseSwitchVeil = (): void => {
    if (!switchVeil || switchVeilRaised) return;
    switchVeilRaised = true;
    relayout();
  };

  const lowerSwitchVeil = (): void => {
    if (!switchVeil || !switchVeilRaised) return;
    switchVeilRaised = false;
    relayout();
  };

  const unmountSwitchVeil = (): void => {
    const view = switchVeil;
    switchVeil = null;
    switchVeilRaised = false;
    if (view) try { base.contentView.removeChildView(view); } catch { /* 이미 떨어졌다. */ }
  };

  layoutConsole();
  base.contentView.addChildView(consoleView);

  return {
    consoleView,
    layoutConsole,
    parkBrowser,
    presentBrowser,
    removeBrowser,
    presentPicker: presentPickerView,
    removePicker: removePickerView,
    presentVeil: presentVeilView,
    removeVeil: removeVeilView,
    mountSwitchVeil,
    raiseSwitchVeil,
    lowerSwitchVeil,
    unmountSwitchVeil,
  };
}

export function createDesktopShellWindow(base: BaseWindow, consoleView: WebContentsView, stack: DesktopViewStack): DesktopShellWindow {
  const consoleContents = consoleView.webContents;
  return {
    base,
    consoleView,
    consoleContents,
    stack,
    get webContents() { return consoleContents; },
    isDestroyed: () => base.isDestroyed(),
    show: () => base.show(),
    hide: () => base.hide(),
    focus: () => base.focus(),
    isMinimized: () => base.isMinimized(),
    restore: () => base.restore(),
    getBounds: () => base.getBounds(),
    getContentBounds: () => base.getContentBounds(),
    getMediaSourceId: () => base.getMediaSourceId(),
    isFullScreen: () => base.isFullScreen(),
    loadURL: (url) => consoleContents.loadURL(url),
    loadFile: (path) => consoleContents.loadFile(path),
    setWindowButtonPosition: (position) => base.setWindowButtonPosition(position),
    setTitleBarOverlay: (options) => base.setTitleBarOverlay(options),
  };
}

export interface ParkViewport {
  readonly width: number;
  readonly height: number;
}

/** 아직 한 번도 그려지지 않은 뷰 — 창 전체가 아니라 대표적인 nonzero viewport. */
export function defaultParkViewport(content: Rectangle): ParkViewport {
  return {
    width: Math.max(1, Math.min(800, Math.max(1, content.width))),
    height: Math.max(1, Math.min(600, Math.max(1, content.height))),
  };
}

/**
 * Parking native bounds: viewport 크기는 유지하고 origin 만 (0,0) 으로 옮긴다.
 * width/height 는 항상 ≥1 — 0×0 은 이 통합에서 CDP 를 불안정하게 만든다.
 * 창보다 큰 viewport 는 content 안으로 clamp — Console coverage 를 벗어나지 않게.
 */
export function parkedNativeBounds(viewport: ParkViewport, content: Rectangle): Rectangle {
  const maxW = Math.max(1, content.width);
  const maxH = Math.max(1, content.height);
  return {
    x: 0,
    y: 0,
    width: Math.max(1, Math.min(Math.max(1, viewport.width), maxW)),
    height: Math.max(1, Math.min(Math.max(1, viewport.height), maxH)),
  };
}

/** 전체화면 동기화는 BaseWindow 이벤트와 Console contents 로드 신호를 함께 본다. */
export function desktopFullscreenHost(shell: DesktopShellWindow): DesktopFullscreenWindow {
  const base = shell.base;
  const host: DesktopFullscreenWindow = {
    isFullScreen: () => shell.isFullScreen(),
    on: (event, listener) => { (base.on as (event: string, listener: () => void) => BaseWindow)(event, listener); return host; },
    removeListener: (event, listener) => { (base.removeListener as (event: string, listener: () => void) => BaseWindow)(event, listener); return host; },
    webContents: shell.consoleContents,
  };
  return host;
}
