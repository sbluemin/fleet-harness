import { React } from "@fleet-console/sdk/plugin/browser";
import type { PersistentComponentContext } from "@fleet-console/sdk/plugin";
import { createPortal, flushSync } from "react-dom";

import { isDesktopShell } from "../../../core/client/src/integration/desktop-shell.js";
import { themePolarity } from "../../../core/client/src/integration/store.js";
import { useConsoleOverlayActive, publishBrowserViewRect, useFloatingOverlapActive } from "../../../core/client/src/overlay/overlay-registry.js";
import { Toast } from "../../../core/client/src/chrome/components/toast.js";
import { getT } from "./i18n.js";
import { ChromeImportDialog, chromeImportUnavailable, ImportGlyph, loadChromeImportSources, type ChromeImportSources } from "./chrome-import.js";
import {
  chooseGlobalProfile,
  clearGlobalProfile,
  closeGlobalBrowser,
  closeGlobalTab,
  createGlobalTab,
  dismissClosedGlobalTabs,
  dismissSharedFallback,
  importGlobalFromChrome,
  navigateGlobal,
  placeGlobal,
  restoreClosedGlobalTabs,
  selectGlobalTab,
  setGlobalColorScheme,
  setGlobalViewport,
  useGlobalBrowserBackgroundSeen,
  useGlobalBrowserOpen,
  useGlobalBrowserState,
  useSharedFallbackNotice,
  type GlobalBrowserState,
  type GlobalBrowserUnavailableReason,
} from "./global-browser-store.js";
import { useGlobalBrowserShortcutsSync } from "./global-shortcuts-sync.js";
import "./browser-panel.css";
import "./global-browser-sheet.css";

/**
 * 전역 Fleet 브라우저 — 맵 아레나 위에 뜨는 시트(시안 C).
 *
 * - Operation companion과 같은 캡션 탭 스트립·nav 줄 부품을 쓴다(op-browser-* 클래스 재사용).
 * - 닫혀도 탭은 서버에 주차된다. 닫을 때 포커스는 시트를 열었던 출발 요소로 돌아간다.
 * - Esc는 시트 크롬에 포커스가 있을 때만 닫는다. 네이티브 뷰에 포커스가 있으면
 *   Esc는 페이지의 몫이다(중계 등록을 하지 않으므로 Console에 닿지 않는다).
 * - 시트가 열린 채 Console 링크를 누르면 시트는 닫히지 않고 새 탭이 열린다(mission 13의
 *   openLink가 처리). scrim 직접 클릭만 닫는다.
 * - role은 region이다. dialog면 오버레이 레지스트리가 시트가 열린 내내 켜져
 *   뷰가 영원히 물러서므로(dialog 아님 — 포커스 트랩도 없다).
 */

const PLACE_POLL_MS = 200;
const BROWSER_PROFILE = "default";
/** 시트가 알아볼 수 있는 최소 숨구멍 — 모자라면 크롬을 무시하고 여백을 줄인다. */
const MIN_SHEET_WIDTH = 280;
const MIN_SHEET_HEIGHT = 200;

/** 카드 세로 여백 — .operations-side-bar·.right-rail의 top·bottom 인셋과 같은 토큰
    (theme.css --space-3). 토큰을 못 읽는 환경이면 같은 값을 쓴다. */
function readCardInset(): number {
  if (typeof window === "undefined" || typeof document === "undefined") return 12;
  const parsed = Number.parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue("--space-3"));
  return Number.isFinite(parsed) ? parsed : 12;
}

type Services = { readonly language: PersistentComponentContext["language"]; readonly theme: PersistentComponentContext["theme"] };

function unavailableText(t: ReturnType<typeof getT>, reason: GlobalBrowserUnavailableReason | null, desktop: boolean): { title: string; body: string | null } {
  if (!desktop) return { title: t("terminal.browser.desktopOnly"), body: t("terminal.browser.desktopOnlyBody") };
  if (reason === "shared") return { title: t("terminal.browser.shared"), body: t("terminal.browser.sharedBody") };
  return { title: t("terminal.browser.desktopMissing"), body: null };
}

function hostOf(url: string): string {
  try { const parsed = new URL(url); return parsed.host || url; } catch { return url; }
}

type Box = { readonly width: number; readonly height: number };
/** 한 park 회차에 물러난 뷰를 찍은 장. width·height는 디코드된 원본 크기다. */
type StillFrame = Box & { readonly tabId: string; readonly url: string; readonly src: string };

/**
 * 찍힌 장이 지금 자리와 맞는가. 물러난 뷰는 마지막으로 놓였던 크기를 지키므로, 그 뒤 자리가 바뀌었으면 맞지 않는다.
 * 캡처는 화면 배율(DPR 2면 자리의 두 배) 픽셀, 자리는 CSS px라 화면·Console 배율(⌘+)만큼 고르게 다르다 — 배율 하나로 맞춰 본 뒤
 * 남는 어긋남이 자리 기준 2px 안이어야 한다. 늘이거나 잘라 끼우는 장은 보이지 않는다.
 */
function stillFits(still: Box, box: Box): boolean {
  if (still.width < 1 || still.height < 1 || box.width < 1 || box.height < 1) return false;
  const scale = still.width / box.width;
  if (scale < 0.25 || scale > 5) return false;
  return Math.abs(still.height / scale - box.height) <= 2;
}

export function GlobalBrowserSheet({ language, theme }: Services) {
  return <GlobalBrowserSheetBody language={language} theme={theme} />;
}

function GlobalBrowserSheetBody({ language, theme }: Services) {
  const t = getT(language ?? "en");
  const open = useGlobalBrowserOpen();
  const mobile = typeof document !== "undefined" && document.documentElement.dataset.viewMode === "mobile";
  const desktop = isDesktopShell();
  const enabled = !mobile;
  const { state } = useGlobalBrowserState(enabled);
  const overlayActive = useConsoleOverlayActive();
  const floatingOverlap = useFloatingOverlapActive();
  useGlobalBrowserBackgroundSeen(open);
  // shared 폴백 안내는 시트가 닫혀 있어도 보여야 한다 — 일찍 구독한다.
  const fallbackNotice = useSharedFallbackNotice();
  // 서버 라우트가 아직 없어도(호스트 구현 중) 깨지지 않게 실패를 삼킨다.
  useGlobalBrowserShortcutsSync(enabled && desktop);

  const available = desktop && state?.available === true;
  const activeTab = available ? state?.tabs.find((tab) => tab.id === state.activeTabId) ?? null : null;

  const sheetRef = React.useRef<HTMLElement | null>(null);
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const urlRef = React.useRef<HTMLInputElement | null>(null);
  const [urlDraft, setUrlDraft] = React.useState("");
  const [editingUrl, setEditingUrl] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [info, setInfo] = React.useState<string | null>(null);
  const [importSources, setImportSources] = React.useState<ChromeImportSources | null>(null);
  const [geometry, setGeometry] = React.useState<{ left: number; top: number; right: number; bottom: number } | null>(null);
  // scrim은 아레나(캔버스)만 덮는다 — 도구모음·섬·레일·사이드바는 기하 밖이라 그대로 조작된다.
  const [scrimGeometry, setScrimGeometry] = React.useState<{ left: number; top: number; right: number; bottom: number } | null>(null);
  const [still, setStill] = React.useState<StillFrame | null>(null);
  const [viewportBox, setViewportBox] = React.useState<Box | null>(null);
  const [profileMenu, setProfileMenu] = React.useState(false);
  const [viewportMenu, setViewportMenu] = React.useState(false);
  const [confirming, setConfirming] = React.useState<"profile" | "clear" | null>(null);
  const [pendingProfile, setPendingProfile] = React.useState<string | null>(null);

  const placeKeyRef = React.useRef("");
  const activeTabRef = React.useRef(activeTab);
  activeTabRef.current = activeTab;

  // 시트 열림 표식 — 토스트 스택을 시트 밖으로 비키는 CSS가 이 값을 본다.
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    if (open) document.documentElement.dataset.fleetBrowserSheet = "open";
    else delete document.documentElement.dataset.fleetBrowserSheet;
    return () => { delete document.documentElement.dataset.fleetBrowserSheet; };
  }, [open ]);

  React.useEffect(() => { if (!info) return; const timer = setTimeout(() => setInfo(null), 4000); return () => clearTimeout(timer); }, [info]);
  // 시트가 내려가면 열려 있던 가져오기 대화상자도 거둔다 — 다시 열었을 때 낡은 원본 목록이 남지 않게.
  React.useEffect(() => { if (!open) setImportSources(null); }, [open]);

  React.useEffect(() => {
    if (!editingUrl) setUrlDraft(activeTab?.url === "about:blank" ? "" : activeTab?.url ?? "");
  }, [activeTab?.url, editingUrl]);

  // 정지 화면이 맞춰 볼 자리 — 뷰포트 상자의 CSS 크기.
  React.useEffect(() => {
    const element = viewportRef.current;
    if (!open || !element) { setViewportBox(null); return; }
    const read = () => {
      const rect = element.getBoundingClientRect();
      setViewportBox((current) => current && current.width === rect.width && current.height === rect.height ? current : { width: rect.width, height: rect.height });
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open]);

  const place = React.useCallback((visible: boolean, bounds?: { x: number; y: number; width: number; height: number }) => {
    const key = visible && bounds
      ? `1:${Math.round(bounds.x)},${Math.round(bounds.y)},${Math.round(bounds.width)},${Math.round(bounds.height)}`
      : "0";
    if (placeKeyRef.current === key) return;
    placeKeyRef.current = key;
    void placeGlobal(visible, bounds);
  }, []);

  // ---- 자리: 좌우는 아레나(사이드바·레일 제외) 안쪽 24px, 위·아래는 카드 선. ----
  // 위·아래는 보이는 카드(사이드바 우선, 없으면 레일)의 실제 테두리에 맞춘다.
  // 카드가 하나도 없으면 카드가 서는 자리(offsetParent = .console-body) + 카드 여백 토큰 —
  // 밴드+12는 알약 bottom 기준이라 카드선(본문 top + --space-3)보다 위에 선다(QA-16).
  // Zen 아래는 부유 섬 위 12px 규칙 유지.
  // 아레나가 최소 숨구멍보다 좁으면 사이드바·레일을 무시하고 밴드 아래 창 전체를 쓰고,
  // 그것도 모자라면 여백을 줄여서라도 보이게 한다 — 「열림」인데 안 보이는 상태는 두지 않는다.
  // hold: 크롬이 움직이는 동안에는 시트가 줄어들기만 한다(가장자리마다 안쪽으로만). 넓어지는 쪽은 정착 뒤에 선다.
  const measureGeometry = React.useCallback((hold = false) => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const sidebar = document.querySelector(".operations-side-bar") as HTMLElement | null;
    const rail = document.querySelector(".right-rail") as HTMLElement | null;
    const island = document.querySelector(".zen-bar") as HTMLElement | null;
    const band = document.querySelector(".console-toolbar") as HTMLElement | null;
    const zen = document.querySelector(".console-shell.is-zen") !== null;
    // 보이는 카드(사이드바 우선, 없으면 레일) — 닫힘(폭 0·숨김)·Zen 밀어내기는 카드가 아니다.
    // .operations-side-bar·.right-rail은 컨테이너 자체가 부유 유리 카드다(안쪽 카드 요소 없음.
    // components.css .operations-side-bar / rail.css .right-rail, 둘 다 top·bottom: var(--space-3)).
    // 좌우·scrim도 같은 판정에서 나온다 — 닫힌 사이드바의 2px 테두리 자투리가
    // 왼쪽 간격을 38로 벌리지 않게(QA-16). War Room 접힘은 서랍만 걷고 밴드 줄이 남으니
    // 같은 규칙이 그대로 성립한다.
    // 접힘은 픽 중에도 아레나 기하를 유지한다. 닫힘 전이의 잔폭 역시 카드가 아니다.
    const sidebarCardRect = sidebar !== null && !sidebar.classList.contains("is-closed") && sidebar.offsetWidth > 4
      && window.getComputedStyle(sidebar).visibility !== "hidden"
      ? sidebar.getBoundingClientRect()
      : null;
    // 레일도 사이드바와 같은 규칙이다 — 닫힘(is-open 해제) 전이의 잔폭은 카드가 아니다.
    const railCardRect = rail !== null && rail.classList.contains("is-open") && rail.offsetWidth > 4
      && window.getComputedStyle(rail).visibility !== "hidden"
      ? rail.getBoundingClientRect()
      : null;
    const cardRect = sidebarCardRect ?? railCardRect;
    const sideRight = sidebarCardRect !== null ? sidebarCardRect.right : 0;
    const railRect = railCardRect;
    const bandRect = band && band.offsetWidth > 0 ? band.getBoundingClientRect() : null;
    const islandRect = island && island.offsetWidth > 0 ? island.getBoundingClientRect() : null;
    const zenIsland = zen && islandRect;
    // scrim 자리 — 24px 안쪽 여백 없이 아레나 자체. 밴드·섬·레일·사이드바는 밖에 둔다.
    const scrim = zenIsland
      ? { left: 0, top: 0, right: 0, bottom: Math.round(vh - islandRect.top) }
      : { left: Math.round(sideRight), top: Math.round(bandRect ? bandRect.bottom : 0), right: Math.round(railRect ? vw - railRect.left : 0), bottom: 0 };
    setScrimGeometry((current) => current && current.left === scrim.left && current.top === scrim.top && current.right === scrim.right && current.bottom === scrim.bottom
      ? current
      : scrim);
    let left = Math.round((sideRight > 0 ? sideRight : 0) + 24);
    let right = Math.round(railRect ? vw - railRect.left + 24 : 24);
    // 위·아래 선 — 보이는 카드가 있으면 그 테두리선 그대로. 카드가 하나도 없으면
    // 카드가 서는 자리(사이드바·레일의 offsetParent = .console-body) + 카드 여백 토큰으로 —
    // 위·아래 모두 같은 원칙이다. 맨 마지막 수단(본문 요소도 없음)에만 밴드 기준·토큰 단독.
    const cardInset = readCardInset();
    const cardHost = sidebar?.offsetParent ?? rail?.offsetParent ?? null;
    const cardHostRect = cardHost ? cardHost.getBoundingClientRect() : null;
    const fallbackTop = cardHostRect ? cardHostRect.top + cardInset : (bandRect ? bandRect.bottom : 0) + cardInset;
    const fallbackBottom = cardHostRect ? vh - cardHostRect.bottom + cardInset : cardInset;
    let top: number;
    let bottom: number;
    if (zenIsland) {
      top = Math.round(cardRect ? cardRect.top : fallbackTop);
      bottom = Math.round(vh - islandRect.top + 12);
    } else {
      top = Math.round(cardRect ? cardRect.top : fallbackTop);
      bottom = Math.round(cardRect ? vh - cardRect.bottom : fallbackBottom);
    }
    if (vw - left - right < MIN_SHEET_WIDTH) {
      // 좁은 아레나 — 크롬을 무시하고 창 너비를 쓴다. 시트가 레일·사이드바 위에 겹쳐 선다.
      left = 24;
      right = 24;
    }
    if (vw - left - right < MIN_SHEET_WIDTH) {
      const margin = Math.max(8, Math.floor((vw - MIN_SHEET_WIDTH) / 2));
      left = margin;
      right = margin;
    }
    if (vh - top - bottom < MIN_SHEET_HEIGHT) {
      bottom = 12;
    }
    if (vh - top - bottom < MIN_SHEET_HEIGHT) {
      top = Math.max(8, vh - bottom - MIN_SHEET_HEIGHT);
    }
    const measured = { left, top, right, bottom };
    setGeometry((current) => {
      const next = hold && current
        ? { left: Math.max(current.left, left), top: Math.max(current.top, top), right: Math.max(current.right, right), bottom: Math.max(current.bottom, bottom) }
        : measured;
      return current && current.left === next.left && current.top === next.top && current.right === next.right && current.bottom === next.bottom
        ? current
        : next;
    });
    // 크롬의 기하 전이나 끌기 리사이즈가 남았다면 자리는 아직 움직이는 중이다 — 최종 자리는 멈춘 뒤에 다시 잰다.
    // 섬·밴드는 위·아래 선만 정하므로 세로 기하만 본다(섬의 가로 물러남은 시트 자리를 바꾸지 않는다).
    const cardMotion = ["width", "height", "transform", "left", "right", "top", "bottom"];
    const lineMotion = ["height", "transform", "top", "bottom"];
    const settling = sidebar?.dataset.resizing === "true" || rail?.classList.contains("is-dragging") === true
      || ([[sidebar, cardMotion], [rail, cardMotion], [island, lineMotion], [band, lineMotion]] as const).some(([element, properties]) =>
        (element?.getAnimations?.() ?? []).some((animation) => properties.includes((animation as CSSTransition).transitionProperty)));
    return { ...measured, settling };
  }, []);

  // ---- 크롬 기하 변화: 사이드바 펼침·접힘, 레일 열기·닫기, 끌기 리사이즈 ----
  // 시트 면(DOM)은 IPC가 없으니 매 프레임 따라가되 움직이는 동안에는 줄어들기만 한다. 네이티브 뷰는
  // Console 왕복(POST → SSE → setBounds)만큼 늦게 따라오므로 매 프레임 추종하면 크롬이 다가오는 쪽에서
  // 그 지연만큼 덮고, 프레임마다 페이지 리사이즈가 일어난다. 그래서
  // - 시트가 줄어드는(크롬이 다가오는) 움직임이면 뷰를 물린다. 물러남은 크기를 바꾸지 않는 z 순서 이동이다.
  // - 시트가 넓어지는(크롬이 물러나는) 움직임이면 뷰는 제자리에 둔다. 비켜나는 크롬은 덮이지 않는다.
  // 어느 쪽이든 정착한 뒤 최종 자리에 한 번 놓는다.
  const [chromeParked, setChromeParked] = React.useState(false);
  const chromeMovingRef = React.useRef(false);
  const geometryRef = React.useRef(geometry);
  geometryRef.current = geometry;

  React.useEffect(() => {
    if (!open) { setGeometry(null); setChromeParked(false); return; }
    type Measured = NonNullable<ReturnType<typeof measureGeometry>>;
    type Edges = { left: number; top: number; right: number; bottom: number };
    const same = (a: Edges, b: Edges) => a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
    const shrank = (from: Edges | null, to: Edges | null) => from !== null && to !== null
      && (to.left > from.left || to.top > from.top || to.right > from.right || to.bottom > from.bottom);
    let frame = 0;
    let last: Measured | null = null;
    let parkedForMotion = false;
    // 한 번 재고, 시트가 줄어들면(또는 방향을 아직 모르면) 같은 커밋에서 뷰를 물린다 — 줄어든 자리로
    // 먼저 setBounds했다가 다시 물리는 왕복을 만들지 않는다. rAF·관찰자 콜백의 갱신은 기본 우선순위로
    // 미뤄져 페인트보다 늦을 수 있으니 같은 프레임에 동기로 커밋한다.
    const step = (parkUnlessMoved: boolean) => {
      const before = geometryRef.current;
      let measured: Measured | undefined;
      flushSync(() => {
        measured = measureGeometry(true);
        if (!measured || parkedForMotion) return;
        const shown = before === null ? measured : {
          left: Math.max(before.left, measured.left), top: Math.max(before.top, measured.top),
          right: Math.max(before.right, measured.right), bottom: Math.max(before.bottom, measured.bottom),
        };
        const unknown = parkUnlessMoved && measured.settling && before !== null && same(before, measured);
        if (unknown || shrank(before, shown)) {
          parkedForMotion = true;
          setChromeParked(true);
        }
      });
      return { before, measured };
    };
    const follow = () => {
      frame = 0;
      const { measured } = step(false);
      if (!measured) { chromeMovingRef.current = false; return; }
      const stopped = last !== null && same(last, measured) && !measured.settling;
      last = measured;
      if (!stopped) { frame = requestAnimationFrame(follow); return; }
      // 정착 — 넓어지는 쪽을 포함한 최종 자리를 세우고 물러남을 푼다. 배치가 그 자리를 확인하고 뷰를 한 번 놓는다.
      chromeMovingRef.current = false;
      parkedForMotion = false;
      flushSync(() => { measureGeometry(); setChromeParked(false); });
    };
    // 클래스·인라인 폭이 바뀐 직후, 전이의 첫 프레임이 칠해지기 전에 판정한다. 접힌 사이드바가 펼쳐지거나
    // 레일이 열리는 순간에는 카드 폭이 아직 0이라 방향을 모른다 — 그때도 기하 전이가 시작됐으면 먼저 물린다.
    const onChromeChange = () => {
      if (frame !== 0) return;
      const { before, measured } = step(true);
      if (!measured) return;
      if (!measured.settling && before !== null && same(before, measured)) return;
      chromeMovingRef.current = true;
      last = measured;
      frame = requestAnimationFrame(follow);
    };
    const observer = new MutationObserver(onChromeChange);
    let watched: Element[] = [];
    // 크롬은 모드·페이지에 따라 다시 마운트된다. 주기 재측정 때 관찰 대상을 다시 붙든다.
    const watch = () => {
      const next = [".operations-side-bar", ".right-rail", ".zen-bar", ".console-toolbar"]
        .map((selector) => document.querySelector(selector))
        .filter((element): element is Element => element !== null);
      if (next.length === watched.length && next.every((element, index) => element === watched[index])) return;
      observer.disconnect();
      watched = next;
      for (const element of watched) observer.observe(element, { attributes: true, attributeFilter: ["class", "style", "data-resizing"] });
    };
    const remeasure = () => {
      watch();
      if (frame === 0) measureGeometry();
    };
    remeasure();
    window.addEventListener("resize", remeasure);
    const timer = setInterval(remeasure, 1000);
    return () => {
      window.removeEventListener("resize", remeasure);
      clearInterval(timer);
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
      chromeMovingRef.current = false;
      setChromeParked(false);
    };
  }, [open, measureGeometry]);

  // ---- 네이티브 뷰 배치: 겹침이 뜨면 즉시 물리고, 물러난 뒤 찍은 정지 화면을 깐다. ----
  // 캡처를 기다렸다 물리지 않는다(H2) — 정지 화면은 물러난 뒤에 찍어 도착하면 깐다(아래 park 회차).
  // 토스트·말풍선은 뷰와 실제로 겹칠 때만 물린다 — 시트 밖으로 비킨 스택에 가려 정지만 보지 않게.
  const parked = !available || activeTab === null || overlayActive || floatingOverlap || chromeParked;
  const syncPlacement = React.useCallback(() => {
    if (!open) return;
    const element = viewportRef.current;
    if (!element) return;
    if (!parked && !placeKeyRef.current.startsWith("1:")) {
      // 어느 오버레이에서 복귀하든, 물러난 동안 바뀐 크롬 기하를 먼저 잰다.
      // 새 기하가 DOM에 반영되기 전에는 낡은 bounds로 뷰를 되살리지 않는다.
      const measured = measureGeometry(chromeMovingRef.current);
      if (!measured || measured.settling || !geometry || geometry.left !== measured.left || geometry.top !== measured.top
        || geometry.right !== measured.right || geometry.bottom !== measured.bottom) {
        place(false);
        return;
      }
    }
    // 판정용 자리는 「놓으려는 자리」다 — 물러나 있을 때도 유지해야 토스트 교차가 풀린다.
    // 닫을 때만 null로 거둔다.
    const rect = element.getBoundingClientRect();
    if (rect.width >= 1 && rect.height >= 1) {
      publishBrowserViewRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    }
    if (parked || rect.width < 1 || rect.height < 1 || document.visibilityState !== "visible") {
      place(false);
      return;
    }
    place(true, { x: rect.left, y: rect.top, width: rect.width, height: rect.height });
  }, [open, parked, geometry, measureGeometry, place]);
  // 복귀용 기하 반영은 페인트 전에 끝낸다. 폴링도 같은 가드를 써 우회하지 못한다.
  React.useLayoutEffect(syncPlacement, [syncPlacement, activeTab?.id]);
  React.useEffect(() => {
    if (!open) return;
    const timer = setInterval(syncPlacement, PLACE_POLL_MS);
    return () => clearInterval(timer);
  }, [open, syncPlacement]);
  // 시트가 내려가면 뷰도 감춘다 — 자리를 알린 사람이 없는 뷰는 남지 않는다(탭은 서버에 주차된다).
  // 마운트 직후 닫혀 있으면 한 번 내린다. reload 뒤 서버에 남은 배치를 새 세션의 키와 무관하게 지운다.
  React.useEffect(() => {
    if (!open) {
      publishBrowserViewRect(null);
      place(false);
    }
  }, [open, place]);

  // ---- park 회차: 물러날 때마다 Console 뒤에 선 뷰를 한 장 찍는다 ----
  // 물러난 뷰도 계속 그려지므로 그 한 장이 물러난 순간의 화면이다. 도착 전(대략 150–330ms)과
  // 회차·탭·크기가 어긋난 장은 쓰지 않고 무채색 자리를 둔다 — 낡거나 늘어난 화면을 보이지 않는다.
  // 정지 화면은 품질 요소다. 캡처가 실패해도 무채색 자리로 남을 뿐 주 흐름은 막지 않는다.
  const parkEpochRef = React.useRef(0);
  const wasParkedRef = React.useRef(false);
  const parkedRef = React.useRef(parked);
  parkedRef.current = parked;
  const captureRef = React.useRef<{ readonly controller: AbortController; again: boolean } | null>(null);
  const cancelCapture = React.useCallback(() => {
    captureRef.current?.controller.abort();
    captureRef.current = null;
  }, []);
  const captureStill = React.useCallback(function capture() {
    // 진행 중이면 끝난 뒤 한 번 더 찍는다 — 겹친 요청은 하나로 합친다.
    if (captureRef.current) { captureRef.current.again = true; return; }
    const tab = activeTabRef.current;
    if (!parkedRef.current || !tab) return;
    const epoch = parkEpochRef.current;
    const { id: tabId, url } = tab;
    const task = { controller: new AbortController(), again: false };
    captureRef.current = task;
    const current = () => !task.controller.signal.aborted && parkedRef.current && parkEpochRef.current === epoch
      && activeTabRef.current?.id === tabId && activeTabRef.current?.url === url;
    void (async () => {
      try {
        const response = await fetch("/api/v1/browser/global/screenshot?resolution=device", { signal: task.controller.signal });
        if (!response.ok) return;
        const shot = await response.json() as { data?: string; mimeType?: string; mime?: string };
        if (!shot || typeof shot.data !== "string" || !current()) return;
        const src = `data:${shot.mimeType ?? shot.mime ?? "image/png"};base64,${shot.data}`;
        const img = new Image();
        img.src = src;
        await img.decode();
        if (!current()) return;
        setStill({ tabId, url, src, width: img.naturalWidth, height: img.naturalHeight });
      } catch {
        // 거둔 요청·실패한 캡처는 버린다.
      } finally {
        if (captureRef.current === task) {
          captureRef.current = null;
          if (task.again && parkedRef.current && parkEpochRef.current === epoch) capture();
        }
      }
    })();
  }, []);
  // park 진입마다 회차를 올리고 한 장. 풀리거나 닫히면 진행 중 캡처를 거두고 지난 장을 버린다 —
  // 다음 회차는 빈(무채색) 자리에서 시작한다. 물러난 채 탭이 바뀌면 같은 회차에서 새 탭을 찍는다.
  const capturable = open && available && activeTab !== null && parked;
  React.useEffect(() => {
    if (!capturable) {
      wasParkedRef.current = false;
      cancelCapture();
      setStill(null);
      return;
    }
    if (!wasParkedRef.current) { wasParkedRef.current = true; parkEpochRef.current += 1; }
    cancelCapture();
    setStill(null);
    captureStill();
  }, [capturable, activeTab?.id, activeTab?.url, cancelCapture, captureStill]);
  // 물러난 채 자리 크기가 바뀌어도 다시 찍지 않는다 — 셸은 물러난 뷰를 마지막으로 놓였던 크기로 두므로
  // 새 장도 옛 크기라 맞지 않는다. 그 동안은 stillFits가 장을 거두고 무채색 자리가 선다.
  React.useEffect(() => cancelCapture, [cancelCapture]);

  // 페이지의 prefers-color-scheme은 Console 테마 극성을 따른다(Operation과 같은 계약).
  const polarity = themePolarity(theme ?? "instrument");
  React.useEffect(() => {
    if (!available || !state) return;
    if (state.viewport.colorScheme === polarity) return;
    void setGlobalColorScheme(polarity);
  }, [available, state?.viewport.colorScheme, state?.viewport.setBy, polarity]);

  if (!enabled) return null;
  const toastHost = typeof document === "undefined" ? null : document.querySelector(".app-toast-host");

  const fail = (ok: boolean) => { if (!ok) setNotice(t("terminal.browser.requestFailed")); };
  const runTab = (task: () => Promise<boolean>) => {
    setBusy(true);
    setNotice(null);
    void task().then((ok) => fail(ok)).catch(() => setNotice(t("terminal.browser.requestFailed"))).finally(() => setBusy(false));
  };
  const pickProfile = (value: string | null) => {
    setProfileMenu(false);
    setConfirming(null);
    if (profile === value) return;
    if ((state?.tabs.length ?? 0) > 0) { setPendingProfile(value); setConfirming("profile"); setProfileMenu(true); return; }
    runTab(() => chooseGlobalProfile(value));
  };
  // ---- 브라우저에서 가져오기 — Operation 브라우저와 같은 대화상자. 쿠키는 전역 탭이 쓰는 세션으로 간다 ----
  const openImport = async () => {
    setProfileMenu(false);
    setConfirming(null);
    if (chromeImportUnavailable()) return;
    setNotice(null);
    const loaded = await loadChromeImportSources(t);
    if ("error" in loaded) { setNotice(loaded.error); return; }
    setImportSources(loaded.sources);
  };
  const runImport = async (profileId: string) => {
    setNotice(null);
    const result = await importGlobalFromChrome(profileId);
    if ("error" in result) { setNotice(result.error ?? t("terminal.browser.requestFailed")); return false; }
    setImportSources(null);
    setInfo(t("terminal.browser.import.done", { count: String(result.cookies) }));
    return true;
  };
  const importUnavailable = chromeImportUnavailable();
  const submitUrl = () => {
    const raw = urlDraft.trim();
    if (!raw) return;
    setEditingUrl(false);
    urlRef.current?.blur();
    // 주소창 글은 그대로 보낸다 — 검색어·localhost·host:port 구분은 서버의 주소 해석이 맡는다(Operation 브라우저와 같다).
    // 주소창은 보던 탭을 옮긴다. 탭이 없을 때만 새로 연다.
    if (activeTab === null) runTab(() => createGlobalTab(raw));
    else runTab(() => navigateGlobal(raw, activeTab.id));
  };

  const closedTabs = state?.closedTabs ?? [];
  // 이번 회차에 찍혔고(풀릴 때 비운다) 지금 자리와 크기가 맞는 장만 보인다. 그 밖은 무채색 자리다.
  const shownStill = parked && still && activeTab && viewportBox && still.tabId === activeTab.id && still.url === activeTab.url
    && stillFits(still, viewportBox) ? still : null;
  const profile = available ? state?.profile ?? null : null;
  const defaultProfile = state?.defaultProfile ?? null;
  const persistent = profile !== null;
  const closedDoor = !available ? unavailableText(t, state?.reason ?? null, desktop) : null;
  const empty = available && activeTab === null && closedDoor === null;

  const onSheetKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    // 주소 입력창의 Esc는 입력 취소(블러)다 — 시트를 닫지 않는다.
    if ((event.target as Element | null)?.closest?.(".op-browser__url-input")) return;
    event.preventDefault();
    event.stopPropagation();
    closeGlobalBrowser();
  };

  return (
    <>
      {open ? (
        <>
          {/* 뒤 화면을 가리지 않는 투명한 닫기 영역 — 아레나만 덮고, 닫기는 이 클릭에만.
              도구모음·섬·레일·사이드바는 이 영역 밖에 있어 그대로 조작된다. */}
          {scrimGeometry ? (
            <div
              className="fleet-browser-scrim"
              aria-hidden="true"
              onClick={() => closeGlobalBrowser()}
              style={{ left: scrimGeometry.left, top: scrimGeometry.top, right: scrimGeometry.right, bottom: scrimGeometry.bottom }}
            />
          ) : null}
          <section
        ref={sheetRef}
        id="fleet-browser-sheet"
        className="fleet-browser-sheet"
        role="region"
        aria-label={t("terminal.globalBrowser.sheetAria")}
        onKeyDown={onSheetKeyDown}
        style={geometry ? { left: geometry.left, top: geometry.top, right: geometry.right, bottom: geometry.bottom } : { visibility: "hidden" }}
      >
        <div className="fleet-browser-sheet__cap op-browser-cap">
          <div className="op-browser-cap__tabs" role="tablist" aria-label={t("terminal.browser.tabs")}>
            {(available ? state?.tabs ?? [] : []).map((tab) => (
              <div
                key={tab.id}
                role="tab"
                aria-selected={tab.id === state?.activeTabId}
                className={`op-browser__tab${tab.id === state?.activeTabId ? " is-active" : ""}`}
                onMouseDown={(event) => { if (event.button === 1) { event.preventDefault(); runTab(() => closeGlobalTab(tab.id)); } }}
                onClick={() => { if (tab.id !== state?.activeTabId) runTab(() => selectGlobalTab(tab.id)); }}
                title={tab.url}
              >
                <GlobalTabIcon tab={tab} />
                <span className="op-browser__tab-title">{tab.title || hostOf(tab.url) || t("terminal.browser.newTab")}</span>
                <button
                  type="button"
                  className="op-browser__tab-close"
                  aria-label={t("terminal.browser.closeTab")}
                  onClick={(event) => { event.stopPropagation(); runTab(() => closeGlobalTab(tab.id)); }}
                >×</button>
              </div>
            ))}
            <button
              type="button"
              className="op-browser__icon"
              aria-label={t("terminal.browser.newTab")}
              data-tip={t("terminal.browser.newTab")}
              disabled={!available || busy}
              onClick={() => runTab(() => createGlobalTab())}
            >+</button>
            {/* 탭이 있을 때의 닫힌 탭 제안 — 본문은 네이티브 뷰 자리라 탭 줄 끝에 탭 알약 문법으로 둔다.
                탭이 0개면 빈 상태의 큰 제안이 같은 일을 하므로 그리지 않는다. */}
            {available && closedTabs.length > 0 && !empty ? (
              <div
                className="op-browser__tab fleet-browser-sheet__restore-tab"
                title={t(persistent ? "terminal.globalBrowser.restoreClosedHelpPersistent" : "terminal.globalBrowser.restoreClosedHelpEphemeral")}
              >
                <button
                  type="button"
                  className="fleet-browser-sheet__restore-run"
                  disabled={busy}
                  onClick={() => runTab(() => restoreClosedGlobalTabs())}
                >
                  <ReloadGlyph />
                  <span className="op-browser__tab-title">{t("terminal.globalBrowser.restoreClosed", { count: String(closedTabs.length) })}</span>
                </button>
                <button
                  type="button"
                  className="op-browser__tab-close"
                  aria-label={t("terminal.globalBrowser.dismissClosed")}
                  onClick={() => { void dismissClosedGlobalTabs(); }}
                >×</button>
              </div>
            ) : null}
          </div>
          <div className="op-browser__profile">
            <button
              type="button"
              className={`op-browser__icon op-browser__pchip${persistent ? " is-persistent" : ""}`}
              aria-haspopup="menu"
              aria-expanded={profileMenu}
              aria-label={t(persistent ? "terminal.browser.profile.persistent" : "terminal.browser.profile.ephemeral")}
              data-tip={t(persistent ? "terminal.browser.profile.persistentTip" : "terminal.browser.profile.ephemeralTip")}
              disabled={!available}
              onClick={() => { setProfileMenu((value) => !value); setConfirming(null); }}
            >
              {persistent ? <ProfileGlyph /> : <EphemeralGlyph />}
            </button>
            {profileMenu ? (
              <div className="op-browser__menu" role="menu">
                {([null, BROWSER_PROFILE] as const).map((value) => (
                  <div
                    key={value ?? "ephemeral"}
                    role="menuitemradio"
                    tabIndex={0}
                    aria-checked={profile === value}
                    className="op-browser__menu-item"
                    onClick={() => pickProfile(value)}
                    onKeyDown={(event) => {
                      if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                        event.preventDefault();
                        // 키보드로 골라도 마우스와 같은 확인을 거친다 — 세션을 바꾸면 열린 탭이 모두 닫힌다.
                        pickProfile(value);
                      }
                    }}
                  >
                    <span className="op-browser__menu-glyph" aria-hidden="true">{value ? <ProfileGlyph /> : <EphemeralGlyph />}</span>
                    <span className="op-browser__menu-body">
                      <strong>{t(value ? "terminal.browser.profile.persistent" : "terminal.browser.profile.ephemeral")}</strong>
                      <span className="op-browser__help">{t(value ? "terminal.browser.profile.persistentHelp" : "terminal.browser.profile.ephemeralHelp")}</span>
                    </span>
                    <span className="op-browser__menu-tail">
                      {defaultProfile === value ? <span className="op-browser__menu-default">{t("terminal.browser.profile.default")}</span> : null}
                    </span>
                  </div>
                ))}
                <div className="op-browser__menu-sep" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  className="op-browser__menu-item"
                  disabled={importUnavailable}
                  title={importUnavailable ? t("terminal.browser.import.windowsPending") : undefined}
                  onClick={() => { void openImport(); }}
                >
                  <span className="op-browser__menu-glyph" aria-hidden="true"><ImportGlyph /></span>
                  <span className="op-browser__menu-body"><strong>{t("terminal.browser.import.title")}</strong></span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="op-browser__menu-item"
                  onClick={() => {
                    if (confirming === "clear") {
                      setProfileMenu(false);
                      setConfirming(null);
                      runTab(() => clearGlobalProfile());
                      return;
                    }
                    setConfirming("clear");
                  }}
                >
                  <span className="op-browser__menu-glyph" aria-hidden="true"><EraseGlyph /></span>
                  <span className="op-browser__menu-body">
                    <strong>{confirming === "clear" ? t("terminal.browser.profile.clearRun") : t("terminal.browser.profile.clearItem")}</strong>
                    <span className="op-browser__help">{t("terminal.browser.profile.clearScope")}</span>
                  </span>
                </button>
              </div>
            ) : null}
          </div>
          <div className="op-browser__viewport-menu">
            <button
              type="button"
              className="op-browser__icon op-browser__tool"
              aria-haspopup="menu"
              aria-expanded={viewportMenu}
              aria-label={t("terminal.browser.viewport")}
              data-tip={t("terminal.browser.viewport")}
              disabled={!available}
              onClick={() => setViewportMenu((value) => !value)}
            >
              <MonitorGlyph />
            </button>
            {viewportMenu ? (
              <div className="op-browser__menu op-browser__menu--row" role="menu">
                {(["responsive", "mobile", "tablet"] as const).map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    role="menuitemradio"
                    aria-checked={state?.viewport.preset === preset}
                    className="op-browser__icon op-browser__tool"
                    aria-pressed={state?.viewport.preset === preset}
                    aria-label={t(`terminal.browser.preset.${preset}`)}
                    data-tip={t(`terminal.browser.preset.${preset}`)}
                    onClick={() => { setViewportMenu(false); runTab(() => setGlobalViewport(preset)); }}
                  >{preset === "mobile" ? <PhoneGlyph /> : preset === "tablet" ? <TabletGlyph /> : <MonitorGlyph />}</button>
                ))}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="op-browser__icon fleet-browser-sheet__close"
            aria-label={t("terminal.globalBrowser.close")}
            data-tip={t("terminal.globalBrowser.close")}
            onClick={() => closeGlobalBrowser()}
          >×</button>
        </div>
        <div className="op-browser__nav">
          <button type="button" className="op-browser__icon" aria-label={t("terminal.browser.back")} disabled={!activeTab?.canGoBack || busy} onClick={() => activeTab && void navigateGlobal("back", activeTab.id).then((ok) => fail(ok))}>←</button>
          <button type="button" className="op-browser__icon" aria-label={t("terminal.browser.forward")} disabled={!activeTab?.canGoForward || busy} onClick={() => activeTab && void navigateGlobal("forward", activeTab.id).then((ok) => fail(ok))}>→</button>
          <button type="button" className={`op-browser__icon op-browser__reload${activeTab?.loading ? " is-loading" : ""}`} aria-label={t("terminal.browser.reload")} disabled={!activeTab || busy} onClick={() => activeTab && void navigateGlobal("reload", activeTab.id).then((ok) => fail(ok))}><ReloadGlyph /></button>
          <form
            className={`op-browser__url${!editingUrl && urlDraft ? " is-display" : ""}`}
            onSubmit={(event) => { event.preventDefault(); submitUrl(); }}
          >
            {!editingUrl && urlDraft ? <span className="op-browser__url-display" aria-hidden="true"><UrlParts url={urlDraft} /></span> : null}
            <input
              ref={urlRef}
              className="op-browser__url-input"
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder={t("terminal.browser.urlPlaceholder")}
              aria-label={t("terminal.browser.pageUrl")}
              value={urlDraft}
              disabled={!available}
              onFocus={(event) => { setEditingUrl(true); event.currentTarget.select(); }}
              onBlur={() => setEditingUrl(false)}
              onChange={(event) => setUrlDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape") { setEditingUrl(false); event.currentTarget.blur(); } }}
            />
            {activeTab && activeTab.url !== "about:blank" ? (
              <a
                className="op-browser__url-external"
                href={activeTab.url}
                target="_blank"
                rel="noreferrer noopener"
                data-fleet-link="native"
                aria-label={t("terminal.browser.openExternal")}
                title={t("terminal.browser.openExternal")}
              ><ExternalGlyph /></a>
            ) : null}
          </form>
        </div>
        <div className="fleet-browser-sheet__viewport" ref={viewportRef}>
          {notice ? <div className="op-browser__toast is-error" role="alert">{notice}</div> : info ? <div className="op-browser__toast" role="status">{info}</div> : null}
          {importSources ? <ChromeImportDialog t={t} sources={importSources} persistent={persistent} owner="global" onClose={() => setImportSources(null)} onImport={runImport} /> : null}
          {confirming === "profile" ? (
            <div className="op-browser__toast has-action" role="status">
              {t("terminal.browser.profile.switchBody", { count: String(state?.tabs.length ?? 0) })}
              <button
                type="button"
                className="op-browser__toast-action"
                onClick={() => { setConfirming(null); runTab(() => chooseGlobalProfile(pendingProfile)); }}
              >{t("terminal.browser.profile.switchRun")}</button>
            </div>
          ) : null}
          {closedDoor ? (
            <div className="fleet-browser-sheet__empty">
              <GlobeGlyph large />
              <p><strong>{closedDoor.title}</strong></p>
              {closedDoor.body ? <p>{closedDoor.body}</p> : null}
            </div>
          ) : empty ? (
            <div className="fleet-browser-sheet__empty">
              <GlobeGlyph large />
              <p><strong>{t("terminal.globalBrowser.emptyTitle")}</strong></p>
              <p>{t("terminal.globalBrowser.emptyBody")}</p>
              {closedTabs.length > 0 ? (
                <div className="fleet-browser-sheet__restore">
                  <button
                    type="button"
                    className="op-browser__button op-browser__button--primary"
                    disabled={busy}
                    onClick={() => runTab(() => restoreClosedGlobalTabs())}
                  >{t("terminal.globalBrowser.restoreClosed", { count: String(closedTabs.length) })}</button>
                  <p>{t(persistent ? "terminal.globalBrowser.restoreClosedHelpPersistent" : "terminal.globalBrowser.restoreClosedHelpEphemeral")}</p>
                  <button
                    type="button"
                    className="op-browser__toast-action"
                    onClick={() => { void dismissClosedGlobalTabs(); }}
                  >{t("terminal.browser.close")}</button>
                </div>
              ) : null}
            </div>
          ) : null}
          {shownStill ? (
            <img className="fleet-browser-sheet__still" src={shownStill.src} alt="" aria-hidden="true" data-still-frame="true" />
          ) : null}
          {parked && activeTab && !shownStill && !closedDoor && !empty ? <div className="fleet-browser-sheet__placeholder" aria-hidden="true" /> : null}
        </div>
          </section>
        </>
      ) : null}
      {/* shared 폴백 안내 — 시트가 닫혀 있어도 기존 토스트 스택에 얹는다. */}
      {fallbackNotice && toastHost ? createPortal(
        <Toast open tone="info" title={t("terminal.globalBrowser.sharedFallback")} onDismiss={() => dismissSharedFallback()} />,
        toastHost,
      ) : null}
    </>
  );
}

function UrlParts({ url }: { readonly url: string }) {
  let host = url;
  let rest = "";
  try {
    const parsed = new URL(url);
    host = parsed.host;
    rest = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch { /* 검증된 http(s)만 온다 */ }
  return <><strong>{host}</strong>{rest ? <span>{rest}</span> : null}</>;
}

/** 탭 아이콘 — companion TabIcon과 같은 부품. 파비콘은 서버 프록시로 받고, 없거나 깨지면 지구본. */
function GlobalTabIcon({ tab }: { readonly tab: { readonly id: string; readonly favicon: string | null } }) {
  const [broken, setBroken] = React.useState<string | null>(null);
  if (tab.favicon && broken !== tab.favicon) {
    return <img className="op-browser__tab-icon" src={`/api/v1/browser/global/favicon?tabId=${encodeURIComponent(tab.id)}&v=${encodeURIComponent(tab.favicon)}`} alt="" draggable={false} onError={() => setBroken(tab.favicon)} />;
  }
  return <span className="op-browser__tab-icon is-fallback" aria-hidden="true"><GlobeGlyph /></span>;
}

function GlobeGlyph({ large }: { readonly large?: boolean }) {  const size = large ? 28 : 14;
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.4 8h11.2M8 2.4c2 2 2 9.2 0 11.2M8 2.4c-2 2-2 9.2 0 11.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function ExternalGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path d="M6.5 3.5H4A1.5 1.5 0 0 0 2.5 5v7A1.5 1.5 0 0 0 4 13.5h7a1.5 1.5 0 0 0 1.5-1.5V9.5M9.5 2.5H13.5V6.5M13.5 2.5 7.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ReloadGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path d="M13 8A5 5 0 1 1 8 3M8 1v3M6.5 2.5 8 4l1.5-1.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ProfileGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path d="M8 1.8 13 3.6v4.1c0 3-2 5.2-5 6.5-3-1.3-5-3.5-5-6.5V3.6z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function EphemeralGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path d="M3 7.4 4.4 3.4h7.2L13 7.4M1.8 7.4h12.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="5" cy="10.4" r="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11" cy="10.4" r="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7 10.4h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function EraseGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path d="M2.5 6.5 8 12l5.5-5.5-2-2H6.8L2.5 6.5zM4 13.5h8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function MonitorGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <rect x="2" y="3" width="12" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 13h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function PhoneGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <rect x="4.5" y="2" width="7" height="12" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function TabletGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <rect x="3" y="2.5" width="10" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
