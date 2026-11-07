import * as React from "react";
import type { BrowserSpaceState } from "../shared/spaces.js";

/**
 * 패널 ↔ 탭 레일·도구 공유 — 본문(SessionBrowserPanel)이 자기 상태와 손잡이를 여기 올리고, 세로 탭 레일(BrowserTabRail)과
 * 주소줄 끝의 도구(BrowserTools)가 읽는다.
 */

export interface BrowserCaptionTab { readonly id: string; readonly spaceId: string; readonly url: string; readonly title: string; readonly favicon: string | null; readonly loading: boolean }
export interface BrowserPanelSnapshot {
  readonly tabs: readonly BrowserCaptionTab[];
  readonly activeTabId: string | null;
  /** 사령관 브라우저의 스페이스들 — 탭이 있거나 에이전트가 쓰는 중인 것만 온다. 캡션이 칩 줄로 그린다. */
  readonly spaces: readonly BrowserSpaceState[];
  /** 사령관 브라우저 id(`commodore:<id>`) — 스페이스 색이 사령관 아바타를 찾는 데 쓴다. 모르면 null. */
  readonly browserId: string | null;
  /** 이 대화의 스페이스. 스트림 프레임에는 없고 처음 읽을 때만 알려지므로 모르면 null. */
  readonly homeSpaceId: string | null;
  /** 사람 화면에 표시된 탭이 속한 스페이스. 탭이 없으면 null. */
  readonly displayedSpaceId: string | null;
  readonly driving: boolean;
  readonly viewport: { readonly width: number; readonly height: number; readonly preset: "responsive" | "mobile" | "tablet"; readonly setBy: "user" | "agent" | null } | null;
  readonly busy: boolean;
  /** 지금 이 Console 에서 브라우저를 열 수 있는가 — 아니면 캡션의 문(새 탭·뷰포트)도 닫힌다. */
  readonly available: boolean;
  /** 이 Objective 이 쓰는 영속 프로필. `null` 이면 임시 세션 — 캡션의 표식이 이것을 말한다. */
  readonly profile: string | null;
  /** 새 Objective 이 시작하는 세션 — 메뉴의 「기본」 표식이 서는 행. */
  readonly defaultProfile: string | null;
  readonly actions: {
    readonly selectTab: (tabId: string) => void;
    readonly closeTab: (tabId: string) => void;
    /** 새 탭을 연다 — 사람이 연 탭은 그룹 없이 사람 스페이스에 선다. */
    readonly createTab: () => void;
    /** 그 스페이스를 사람 화면에 띄운다 — 화면만 바뀌고 에이전트의 작업 탭은 그대로다. */
    readonly selectSpace: (spaceId: string) => void;
    readonly openImport: () => void;
    readonly setViewport: (preset: "responsive" | "mobile" | "tablet") => void;
    /** 세션을 바꾼다. 열린 탭이 있으면 패널이 먼저 확인을 받는다 — 세션은 뷰에 바꿔 끼울 수 없다. */
    readonly chooseProfile: (profile: string | null) => void;
    /** 새 Objective 의 기본 세션을 정한다. 이 Objective 의 세션은 그대로다. */
    readonly setDefaultProfile: (profile: string | null) => void;
    readonly openClearProfile: () => void;
  };
}

const snapshots = new Map<string, BrowserPanelSnapshot>();
const listeners = new Map<string, Set<() => void>>();

export function publishBrowserPanel(objectiveId: string, snapshot: BrowserPanelSnapshot | null): void {
  if (snapshot) snapshots.set(objectiveId, snapshot); else snapshots.delete(objectiveId);
  for (const listener of listeners.get(objectiveId) ?? []) listener();
}

export function useBrowserPanel(objectiveId: string): BrowserPanelSnapshot | null {
  const subscribe = React.useCallback((listener: () => void) => {
    const set = listeners.get(objectiveId) ?? new Set<() => void>();
    set.add(listener); listeners.set(objectiveId, set);
    return () => { set.delete(listener); if (set.size === 0) listeners.delete(objectiveId); };
  }, [objectiveId]);
  return React.useSyncExternalStore(subscribe, () => snapshots.get(objectiveId) ?? null, () => null);
}

// ---------- 밖에서 온 주소 ----------

/**
 * CLI·채팅에서 고른 주소 한 개 — Session 브라우저로 열기가 여기 놓고 companion 을 연다.
 *
 * 패널이 아직 없을 수도 있고(문을 여는 그 순간 마운트된다), 엔진이 뜨는 동안일 수도 있으므로
 * 요청은 패널이 실제로 열 수 있게 될 때까지 남는다. 여는 일은 언제나 패널의 것이다 — 실패·거부의
 * 문장을 가진 쪽이 패널이기 때문이다.
 */
export interface BrowserOpenRequest { readonly url: string; readonly serial: number }

const openRequests = new Map<string, BrowserOpenRequest>();
const openRequestListeners = new Map<string, Set<() => void>>();
let openRequestSerial = 0;

function notifyOpenRequest(objectiveId: string): void {
  for (const listener of openRequestListeners.get(objectiveId) ?? []) listener();
}

export function requestBrowserOpen(objectiveId: string, url: string): void {
  openRequests.set(objectiveId, { url, serial: ++openRequestSerial });
  notifyOpenRequest(objectiveId);
}

/** 패널이 요청을 집어 든다. 그사이 더 새 요청이 들어왔으면 그것은 남는다(직렬 번호로 판정). */
export function takeBrowserOpenRequest(objectiveId: string, serial: number): void {
  if (openRequests.get(objectiveId)?.serial !== serial) return;
  openRequests.delete(objectiveId);
  notifyOpenRequest(objectiveId);
}

export function dropBrowserOpenRequest(objectiveId: string): void {
  if (!openRequests.delete(objectiveId)) return;
  notifyOpenRequest(objectiveId);
}

export function useBrowserOpenRequest(objectiveId: string): BrowserOpenRequest | null {
  const subscribe = React.useCallback((listener: () => void) => {
    const set = openRequestListeners.get(objectiveId) ?? new Set<() => void>();
    set.add(listener); openRequestListeners.set(objectiveId, set);
    return () => { set.delete(listener); if (set.size === 0) openRequestListeners.delete(objectiveId); };
  }, [objectiveId]);
  return React.useSyncExternalStore(subscribe, () => openRequests.get(objectiveId) ?? null, () => null);
}

// ---------- 캡션이 띄운 것 ----------

/**
 * 캡션의 메뉴가 열려 있는가 — 캡션에서 본문으로 흐르는 유일한 신호다.
 *
 * 네이티브 뷰는 언제나 페이지 위에 그려지므로, 캡션에서 본문 영역까지 내려오는 메뉴는 뷰가 물러서지 않으면
 * 그 아래가 가려지고 클릭도 받지 못한다. 대화상자는 `aria-modal` 로 그 사실을 스스로 말하지만 메뉴는 모달이
 * 아니므로(그렇게 만들면 보조기술에 거짓말이 된다) 여기로 알린다.
 */
// 열린 메뉴를 가진 쪽(캡션의 「+N」, 주소줄의 도구 메뉴)이 각자 자기 몫만 알린다 — 하나라도 열려 있으면 뷰가 물러선다.
const captionOverlays = new Map<string, Set<string>>();
const overlayListeners = new Map<string, Set<() => void>>();

export function publishBrowserCaptionOverlay(objectiveId: string, source: string, open: boolean): void {
  const sources = captionOverlays.get(objectiveId) ?? new Set<string>();
  if (sources.has(source) === open) return;
  if (open) sources.add(source); else sources.delete(source);
  if (sources.size > 0) captionOverlays.set(objectiveId, sources); else captionOverlays.delete(objectiveId);
  for (const listener of overlayListeners.get(objectiveId) ?? []) listener();
}

export function useBrowserCaptionOverlay(objectiveId: string): boolean {
  const subscribe = React.useCallback((listener: () => void) => {
    const set = overlayListeners.get(objectiveId) ?? new Set<() => void>();
    set.add(listener); overlayListeners.set(objectiveId, set);
    return () => { set.delete(listener); if (set.size === 0) overlayListeners.delete(objectiveId); };
  }, [objectiveId]);
  return React.useSyncExternalStore(subscribe, () => (captionOverlays.get(objectiveId)?.size ?? 0) > 0, () => false);
}

// ---------- 주소줄 끝에 놓이는 칸의 동작 ----------

/**
 * 머리 없는 브라우저 칸을 그리는 작업대가 주소줄 끝에 이어 붙일 동작(펼치기)을 내려 준다 — 도구모음(세션·뷰포트)과 한 묶음으로 선다.
 * 머리가 있는 칸에서는 그 동작이 머리에 있으므로 비어 있다.
 */
export const BrowserNavTailContext = React.createContext<React.ReactNode>(null);

/**
 * 주소줄 줄을 어디에 그릴지 — 작업대가 머리 없는 브라우저 칸을 그릴 때 내려 준다. `undefined`(기본)는 칸 안(본문 맨 위)이고, 요소는 맨 위 줄의
 * 브라우저 영역에 portal 할 자리, `null` 은 그 자리가 아직 없거나 칸이 숨어 있어 그리지 않는다는 뜻이다. 칸 안과 맨 위 줄에 동시에 서지 않는다.
 */
export const BrowserNavHostContext = React.createContext<HTMLElement | null | undefined>(undefined);

// ---------- 세로 탭 레일의 고정 ----------

/** 세로 탭 레일 폭 — 접힘은 아이콘 한 열, 펼침은 탭 제목과 닫기까지. 값은 CSS 의 `--op-rail-*` 와 짝이다(펼침 폭은 거기서만 읽힌다). */
export const BROWSER_RAIL_COLLAPSED_PX = 54;
export const BROWSER_RAIL_EXPANDED_PX = 237;

const RAIL_PINNED_KEY = "fleet.browser.tabRail.pinned";
const railPinnedListeners = new Set<() => void>();
let railPinned: boolean | null = null;

function readRailPinned(): boolean {
  if (railPinned !== null) return railPinned;
  let stored = false;
  try { stored = window.localStorage.getItem(RAIL_PINNED_KEY) === "1"; } catch { /* 저장소를 못 읽으면 기본(고정 안 함) */ }
  railPinned = stored;
  return stored;
}

/** 레일을 펼친 채로 두는가 — 이 브라우저 화면(localStorage)의 기억이다. 기본은 고정하지 않는다. 모든 패널이 같은 값을 본다. */
export function setBrowserRailPinned(next: boolean): void {
  if (readRailPinned() === next) return;
  railPinned = next;
  try { if (next) window.localStorage.setItem(RAIL_PINNED_KEY, "1"); else window.localStorage.removeItem(RAIL_PINNED_KEY); } catch { /* 기억하지 못해도 이 세션 안에서는 지켜진다 */ }
  for (const listener of railPinnedListeners) listener();
}

export function useBrowserRailPinned(): boolean {
  const subscribe = React.useCallback((listener: () => void) => {
    railPinnedListeners.add(listener);
    return () => { railPinnedListeners.delete(listener); };
  }, []);
  return React.useSyncExternalStore(subscribe, readRailPinned, () => false);
}

// ---------- 네이티브 뷰를 실은 칸의 끌기 ----------

/**
 * 네이티브 뷰를 실은 칸(container)의 경계를 사람이 끌려 한다(held=false: 손잡이를 가리킨다) 또는 끌고 있다(held=true).
 * 네이티브 뷰는 페이지 위에 그려져 끄는 포인터를 가져가므로, 칸 안의 브라우저는 끄는 동안 정지 화면을 깔고 뷰를 물린다. 정지 화면을
 * 누른 뒤에 찍으면 그 왕복(수백 ms) 동안 뷰가 Console 위에 남거나 빈 면이 보이므로, 예고(held=false) 동안 보이는 뷰를 미리 찍어
 * 두고 끌기가 시작되면 기다리지 않고 그 장으로 물러난다. 끄는 동안의 표식은 칸의 `data-resizing` 이 DOM 으로도 말한다 — 이 신호는
 * 그보다 앞서(누르는 그 순간, 렌더 전에) 닿는 길이다.
 */
export type NativeViewResize = { readonly container: Element; readonly held: boolean } | null;

let nativeViewResize: NativeViewResize = null;
const nativeViewResizeListeners = new Set<() => void>();

export function announceNativeViewResize(next: NativeViewResize): void {
  if (next === nativeViewResize || (next !== null && nativeViewResize !== null && next.container === nativeViewResize.container && next.held === nativeViewResize.held)) return;
  nativeViewResize = next;
  for (const listener of nativeViewResizeListeners) listener();
}

export function getNativeViewResize(): NativeViewResize {
  return nativeViewResize;
}

export function subscribeNativeViewResize(listener: () => void): () => void {
  nativeViewResizeListeners.add(listener);
  return () => { nativeViewResizeListeners.delete(listener); };
}

// ---------- 브라우저를 열 수 있는가 ----------

/**
 * 못 여는 까닭. `desktop_required` 는 이 Console 을 보는 Fleet Desktop 창이 없다(브라우저 탭·모바일로 열었거나 Desktop 이 떠났다),
 * `shared` 는 Desktop 창 말고 브라우저·모바일 화면도 붙어 있어 멈췄다.
 */
export type BrowserUnavailableReason = "desktop_required" | "shared";
/** 아직 묻지 않았거나 답을 못 받았으면 null — 그때는 문을 닫지 않는다(모르는 것을 못 쓰는 것으로 보이지 않게). */
export type BrowserEngineState = { readonly available: true } | { readonly available: false; readonly reason: BrowserUnavailableReason } | null;

let engineState: BrowserEngineState = null;
let engineAskedAt = 0;
let engineInflight: Promise<void> | null = null;
const engineListeners = new Set<() => void>();
/** 패널이 열려 있지 않은 동안에도 다른 화면이 붙었다 떠난 사실을 글리프가 따라가는 간격. */
const ENGINE_RECHECK_MS = 10_000;

function isDesktopShellDocument(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.desktopShell === "true";
}

/** 스트림으로 같은 사실을 들은 쪽(패널)이 알려 준다 — 글리프가 다음 물음까지 기다리지 않게. */
export function publishBrowserEngine(next: Exclude<BrowserEngineState, null>): void {
  if (engineState?.available === next.available && (next.available || (engineState && !engineState.available && engineState.reason === next.reason))) return;
  engineState = next;
  for (const listener of engineListeners) listener();
}

export function refreshBrowserEngine(): void { void (engineInflight ?? Promise.resolve()).then(() => askEngine()); }

function askEngine(): void {
  // 브라우저 탭·모바일에는 뷰를 그릴 셸이 없다 — 서버에 묻지 않아도 답이 정해져 있다.
  if (!isDesktopShellDocument()) { publishBrowserEngine({ available: false, reason: "desktop_required" }); return; }
  if (engineInflight || typeof fetch !== "function") return;
  engineAskedAt = Date.now();
  engineInflight = fetch("/api/v1/browser")
    .then(async (response) => {
      if (!response.ok) return;
      const body = await response.json() as { readonly available?: unknown; readonly reason?: unknown };
      if (typeof body.available !== "boolean") return;
      const reason: BrowserUnavailableReason = body.reason === "shared" ? "shared" : "desktop_required";
      publishBrowserEngine(body.available ? { available: true } : { available: false, reason });
    })
    .catch(() => undefined)
    .finally(() => { engineInflight = null; });
}

function subscribeEngine(listener: () => void): () => void {
  engineListeners.add(listener);
  if (engineListeners.size === 1) askEngine();
  // 다른 화면이 붙었다 떠나는 일은 이 화면에 이벤트로 오지 않는다 — 보이는 동안 주기적으로, 탭이 눈에 들어올 때 다시 묻는다.
  const onVisible = () => { if (document.visibilityState === "visible" && Date.now() - engineAskedAt > ENGINE_RECHECK_MS) askEngine(); };
  document.addEventListener("visibilitychange", onVisible);
  const timer = setInterval(onVisible, ENGINE_RECHECK_MS);
  return () => { engineListeners.delete(listener); document.removeEventListener("visibilitychange", onVisible); clearInterval(timer); };
}

/** 문서 수준 라우터가 쓰는 가용성 스냅샷 — 아직 묻지 못했으면 null(모르는 것을 못 쓰는 것으로 보지 않는다). */
export function getBrowserEngineSnapshot(): BrowserEngineState {
  return engineState;
}

/** 이 Console 에서 브라우저를 열 수 있는지. 캡션의 지구본 문은 이것으로 닫히고 열린다. */
export function useBrowserEngine(): BrowserEngineState {
  return React.useSyncExternalStore(subscribeEngine, () => engineState, () => null);
}
