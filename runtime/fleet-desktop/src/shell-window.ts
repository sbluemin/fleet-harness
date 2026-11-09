import type { BaseWindow, Rectangle, TitleBarOverlayOptions, WebContents, WebContentsView } from "electron";
import { loadConsoleDocument } from "./console-handoff.js";

/**
 * Fleet Desktop 의 창 골격 — BaseWindow 와 Console WebContentsView 를 한 몸으로 다룬다.
 *
 * BrowserWindow 의 내장 webContents 는 다른 WebContentsView 로 옮길 수 없다(already attached).
 * Console 은 명시적인 WebContentsView 로만 그리고, Objective 브라우저 뷰는 형제로 쌓는다.
 * Objective Browser 실험에서는 macOS CDP 가 hidden/0×0 에서 불안정해 보였으므로, 네이티브 뷰는
 * visible=true·nonzero bounds 를 유지하고 사용자 노출은 z-order(parking) 로 구분한다.
 */

export interface DesktopViewStack {
  readonly consoleView: WebContentsView;
  /** Console 이 전체 콘텐츠 영역을 불투명하게 덮도록 bounds 를 맞춘다. */
  layoutConsole(): Rectangle;
  /**
   * 브라우저 칸의 크롬 뷰들(레일·주소줄)과 경계 손잡이를 Console 옆에 세우고 Console 폭을 정한다. 뷰의 자리(setBounds)는 호출자가 같은 틱에 정한다.
   * 겹침 순서는 페이지 < 레일 < 주소줄이고 손잡이는 맨 위다 — 호버 펼침과 메뉴가 페이지를 덮는다.
   */
  setBrowserPane(pane: { readonly stage: WebContentsView; readonly rail: WebContentsView; readonly bar: WebContentsView; readonly divider: WebContentsView; readonly consoleWidth: number } | null): void;
  /** CDP 는 살아 있지만 Console 뒤에 두고, 창 오른쪽 아래 모서리 한 픽셀에만 걸쳐 입력을 받을 자리를 없앤다(`parkedNativeBounds`). */
  parkBrowser(view: WebContentsView): void;
  /** Console 앞, picker 아래 — 사용자가 보고 만지는 자리. */
  presentBrowser(view: WebContentsView): void;
  removeBrowser(view: WebContentsView): void;
  /**
   * 갈아타기용 판을 Console 뒤에 미리 붙여 둔다. 창에 붙지 않은 뷰는 숨은 위젯이라 컴포지터가 돌지 않고,
   * 그 위의 이미지 decode·프레임 대기가 끝나지 않는다 — 브라우저 뷰의 parking과 같은 이유로 z-order로만 감춘다.
   */
  parkHold(view: WebContentsView): void;
  /** 호스트를 갈아타는 동안 붙잡아 둔 옛 화면 — 브라우저 뷰 위, 호스트 목록 덮개 아래. */
  presentHold(view: WebContentsView): void;
  removeHold(view: WebContentsView): void;
  /** 호스트 목록 덮개 — 종료 인사 아래 최상단. */
  presentPicker(view: WebContentsView): void;
  removePicker(view: WebContentsView): void;
  /** 종료 인사 — 모든 뷰 위. 떠나는 창에서는 무엇도 그 앞에 서지 않는다. */
  presentVeil(view: WebContentsView): void;
  removeVeil(view: WebContentsView): void;
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
  let hold: WebContentsView | null = null;
  let holdRaised = false;
  let picker: WebContentsView | null = null;
  let veil: WebContentsView | null = null;
  let pane: { stage: WebContentsView; rail: WebContentsView; bar: WebContentsView; divider: WebContentsView; consoleWidth: number } | null = null;

  /** 이미 붙은 뷰는 remove 없이 addChildView(index) 로만 재정렬한다 — CDP 스냅샷마다 renderer churn 을 막는다. */
  const relayout = (): void => {
    const root = base.contentView;
    const ordered: WebContentsView[] = [...(hold && !holdRaised ? [hold] : []), ...parked, consoleView, ...(pane ? [pane.stage] : []), ...presented, ...(pane ? [pane.rail, pane.bar, pane.divider] : [])];
    if (hold && holdRaised) ordered.push(hold);
    if (picker) ordered.push(picker);
    if (veil) ordered.push(veil);
    for (let index = 0; index < ordered.length; index++) root.addChildView(ordered[index]!, index);
  };

  const layoutConsole = (): Rectangle => {
    const { width, height } = base.getContentBounds();
    const bounds = { x: 0, y: 0, width: Math.max(1, width), height: Math.max(1, height) };
    consoleView.setBounds({ ...bounds, width: pane ? Math.min(bounds.width, pane.consoleWidth) : bounds.width });
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

  const parkHoldView = (view: WebContentsView): void => {
    if (hold === view && !holdRaised) return;
    hold = view;
    holdRaised = false;
    relayout();
  };

  const presentHoldView = (view: WebContentsView): void => {
    if (hold === view && holdRaised) return;
    hold = view;
    holdRaised = true;
    relayout();
  };

  const removeHoldView = (view: WebContentsView): void => {
    if (hold === view) { hold = null; holdRaised = false; }
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

  layoutConsole();
  base.contentView.addChildView(consoleView);

  return {
    consoleView,
    layoutConsole,
    setBrowserPane(next) {
      const previous = pane;
      pane = next;
      layoutConsole();
      const same = previous !== null && next !== null && previous.stage === next.stage && previous.rail === next.rail && previous.bar === next.bar && previous.divider === next.divider;
      if (previous && !same) {
        for (const view of [previous.stage, previous.rail, previous.bar, previous.divider]) if (!next || ![next.stage, next.rail, next.bar, next.divider].includes(view)) { try { base.contentView.removeChildView(view); } catch { /* 이미 떨어졌다. */ } }
      }
      // 같은 뷰들의 폭만 바뀌는 끌기·창 크기 조절 틱에서는 z-order 를 다시 쓰지 않는다.
      if (!same) relayout();
    },
    parkBrowser,
    presentBrowser,
    removeBrowser,
    parkHold: parkHoldView,
    presentHold: presentHoldView,
    removeHold: removeHoldView,
    presentPicker: presentPickerView,
    removePicker: removePickerView,
    presentVeil: presentVeilView,
    removeVeil: removeVeilView,
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
    // 떠나는 문서가 보낸 셸 신호가 적재를 거짓 실패로 만들지 않도록 대상 항해의 결과로 판정한다.
    loadURL: (url) => loadConsoleDocument(consoleContents, url),
    loadFile: (path) => consoleContents.loadFile(path),
    setWindowButtonPosition: (position) => base.setWindowButtonPosition(position),
    setTitleBarOverlay: (options) => base.setTitleBarOverlay(options),
  };
}

export interface ParkViewport {
  readonly width: number;
  readonly height: number;
}

/** 아직 한 번도 그려지지 않고 알려진 페이지 크기도 없는 뷰 — Console 의 기본 뷰포트(1280×800)와 같은 크기를 창 안으로 줄인 nonzero viewport. */
export function defaultParkViewport(content: Rectangle): ParkViewport {
  return {
    width: Math.max(1, Math.min(1280, Math.max(1, content.width))),
    height: Math.max(1, Math.min(800, Math.max(1, content.height))),
  };
}

/**
 * Parking native bounds: viewport 크기는 유지하고, 창 콘텐츠 오른쪽 아래 모서리에 한 픽셀만 걸치도록 origin 을 옮긴다.
 * 뷰가 창에 붙어 있고 창과 겹쳐야 CDP 가 살아 있고(0×0·창 밖 전체는 불안정), 겹친 한 픽셀 밖은 창이 그리지도 입력을 받지도 않는다.
 * origin 이 (0,0) 이던 때는 Console 뒤에 숨은 뷰가 창 왼쪽 위(캡션 단추 자리)의 입력을 간헐적으로 가로챘다 — 그 자리는 어떤 단추도 없는 모서리여야 한다.
 * width/height 는 항상 ≥1 — 0×0 은 이 통합에서 CDP 를 불안정하게 만든다.
 * 창보다 큰 viewport 는 content 안으로 clamp — 크기가 Console coverage 를 벗어나지 않게.
 */
export function parkedNativeBounds(viewport: ParkViewport, content: Rectangle): Rectangle {
  const maxW = Math.max(1, content.width);
  const maxH = Math.max(1, content.height);
  return {
    x: maxW - 1,
    y: maxH - 1,
    width: Math.max(1, Math.min(Math.max(1, viewport.width), maxW)),
    height: Math.max(1, Math.min(Math.max(1, viewport.height), maxH)),
  };
}
