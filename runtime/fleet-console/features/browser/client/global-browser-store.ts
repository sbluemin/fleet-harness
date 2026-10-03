import { React } from "@fleet-console/sdk/plugin/browser";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";

import { publishBrowserEngine } from "./browser-panel-store.js";
import { subscribeConsoleChannel } from "../../../core/client/src/integration/operations-sse.js";
import { isDesktopShell } from "../../../core/client/src/integration/desktop-shell.js";
import { getT } from "./i18n.js";

/**
 * 전역 Fleet 브라우저(사람 전용, Operation 비귀속)의 클라이언트 상태.
 *
 * Operation companion(browser-panel-store.ts)이 operationId 키의 스냅샷·열기 요청·캡션
 * 오버레이를 나누듯, 전역 브라우저도 같은 문법으로 시트 열림·보이지 않는 뒤 탭 수·서버
 * 상태를 나눈다. 서버 라우트(`BrowserGlobalState`, `/api/v1/browser/global/*`)는
 * 공유 계약 타입을 기준으로 부르고, 아직 열리지 않은 경로(호스트 구현 중)에서는
 * 조용히 실패해 빈 상태·연결 중 표시로 떨어진다 — 깨지지 않는다.
 */

/** 서버·SSE 수신 호환용 고정 식별자. Operation id와 충돌하지 않는 예약어다(호스트와 같은 값). */
export const GLOBAL_BROWSER_OWNER_ID = "global" as const;

export type GlobalBrowserUnavailableReason = "desktop_required" | "shared";

export interface GlobalBrowserTab {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly favicon: string | null;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export interface GlobalBrowserClosedTab {
  readonly url: string;
  readonly title: string;
}

export interface GlobalBrowserState {
  readonly owner: { readonly kind: "global" };
  readonly operationId: "global";
  readonly profile: string | null;
  readonly defaultProfile: string | null;
  readonly available: boolean;
  readonly reason: GlobalBrowserUnavailableReason | null;
  readonly tabs: readonly GlobalBrowserTab[];
  readonly activeTabId: string | null;
  readonly viewport: { readonly width: number; readonly height: number; readonly scale: number; readonly preset: "responsive" | "mobile" | "tablet"; readonly setBy: "user" | "agent" | null; readonly colorScheme: "light" | "dark" | null };
  readonly consoleErrors: number;
  readonly engine: "idle" | "starting" | "ready" | "failed";
  readonly engineError: string | null;
  readonly closedTabs: readonly GlobalBrowserClosedTab[];
}

const BROWSER_STATE_EVENT = "browser:state";
const GLOBAL_BASE = "/api/v1/browser/global";

async function getGlobalState(): Promise<GlobalBrowserState | null> {
  try {
    const response = await fetch(`${GLOBAL_BASE}/state`);
    if (!response.ok) return null;
    const body = await response.json() as GlobalBrowserState;
    if (!body || body.operationId !== GLOBAL_BROWSER_OWNER_ID) return null;
    return body;
  } catch {
    return null;
  }
}

async function postGlobal(action: string, body: Record<string, unknown>): Promise<Response | null> {
  try {
    return await fetch(`${GLOBAL_BASE}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}

// ---------- 시트 열림 ----------

let sheetOpen = false;
/** 시트를 열었던 출발 요소 — 닫을 때 포커스를 돌려준다. */
let sheetTrigger: HTMLElement | null = null;
const sheetListeners = new Set<() => void>();

function notifySheet(): void {
  for (const listener of sheetListeners) listener();
}

function subscribeSheet(listener: () => void): () => void {
  sheetListeners.add(listener);
  return () => { sheetListeners.delete(listener); };
}

/** 시트를 연다. 출발 요소가 없으면 지금 포커스를 출발점으로 기억한다. */
export function openGlobalBrowser(trigger?: HTMLElement | null): void {
  const next = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  // 같은 상태면 출발점만 갱신하지 않는다 — 닫힘→열림 전이에서만 기억한다.
  if (!sheetOpen) sheetTrigger = next;
  if (sheetOpen) { notifySheet(); return; }
  sheetOpen = true;
  notifySheet();
}

export function closeGlobalBrowser(): void {
  if (!sheetOpen) return;
  sheetOpen = false;
  notifySheet();
  // 닫는 순간 출발점으로 — 시트 안의 포커스가 사라지기 전에 돌려준다.
  sheetTrigger?.focus({ preventScroll: true });
  sheetTrigger = null;
}

export function toggleGlobalBrowser(trigger?: HTMLElement | null): void {
  if (sheetOpen) closeGlobalBrowser();
  else openGlobalBrowser(trigger);
}

export function useGlobalBrowserOpen(): boolean {
  return React.useSyncExternalStore(subscribeSheet, () => sheetOpen, () => false);
}

/** 레일 entry의 켜짐 표시가 구독하는 시트 열림. */
export function subscribeGlobalBrowserOpen(listener: () => void): () => void {
  sheetListeners.add(listener);
  return () => { sheetListeners.delete(listener); };
}

export function isGlobalBrowserOpen(): boolean {
  return sheetOpen;
}

// ---------- 보이지 않는 뒤 탭 ----------

/**
 * 시트를 띄우지 않고 연 뒤 탭 중 아직 보지 않은 수. 도구모음 칸의 점(대기 배지)이
 * 이 수를 읽는다. 시트를 열면 본 것으로 친다.
 */
let unseenBackgroundTabs = 0;
const backgroundListeners = new Set<() => void>();

function notifyBackground(): void {
  for (const listener of backgroundListeners) listener();
}

function subscribeBackground(listener: () => void): () => void {
  backgroundListeners.add(listener);
  return () => { backgroundListeners.delete(listener); };
}

export function noteBackgroundTab(): void {
  if (sheetOpen) return;
  unseenBackgroundTabs += 1;
  notifyBackground();
}

function markBackgroundSeen(): void {
  if (unseenBackgroundTabs === 0) return;
  unseenBackgroundTabs = 0;
  notifyBackground();
}

// 시트를 열면 뒤 탭을 본 것으로 친다 — 구독은 스토어 모듈이 아니라 훅에서 건다.
export function useGlobalBrowserBackgroundSeen(open: boolean): void {
  React.useEffect(() => { if (open) markBackgroundSeen(); }, [open ]);
}

function readBackgroundCount(): number {
  return unseenBackgroundTabs;
}

export const globalBrowserAttention = {
  subscribe: subscribeBackground,
  count: readBackgroundCount,
  label: (count: number, locale: ConsoleLocale) => getT(locale)("terminal.globalBrowser.unseenTabs", { count: String(count) }),
};

// ---------- 전역 상태(SSE 재사용) ----------

/**
 * 전역 상태는 새 스트림을 열지 않고 이미 열려 있는 Operation 스트림의
 * `browser:state`로 받는다(연결 예산 보존). 붙는 순간의 출발점은 한 번 읽는다.
 * 서버 경로가 아직 없으면(호스트 구현 중) null로 남아 빈 상태로 그린다.
 */
export function useGlobalBrowserState(enabled: boolean): { readonly state: GlobalBrowserState | null; readonly connected: boolean } {
  const [state, setState] = React.useState<GlobalBrowserState | null>(null);
  const [connected, setConnected] = React.useState(false);
  React.useEffect(() => {
    if (!enabled || !isDesktopShell()) { setState(null); setConnected(false); return; }
    let disposed = false;
    let streamed = false;
    const receive = (payload: unknown) => {
      const next = payload as GlobalBrowserState | null;
      if (disposed || !next || next.operationId !== GLOBAL_BROWSER_OWNER_ID) return;
      streamed = true;
      setState(next);
      setConnected(true);
      publishBrowserEngine(next.available ? { available: true } : { available: false, reason: next.reason ?? "desktop_required" });
    };
    const unsubscribe = subscribeConsoleChannel(BROWSER_STATE_EVENT, receive);
    void getGlobalState().then((body) => { if (!disposed && !streamed && body) receive(body); }).catch(() => undefined);
    return () => { disposed = true; unsubscribe(); };
  }, [enabled]);
  return { state, connected };
}

// ---------- 사용자 동작(실패는 호출부가 문장으로) ----------

export async function createGlobalTab(url?: string): Promise<boolean> {
  const response = await postGlobal("tabs", url ? { action: "create", url } : { action: "create" });
  return response !== null && response.ok;
}

export async function selectGlobalTab(tabId: string): Promise<boolean> {
  const response = await postGlobal("tabs", { action: "select", tabId });
  return response !== null && response.ok;
}

export async function closeGlobalTab(tabId: string): Promise<boolean> {
  const response = await postGlobal("tabs", { action: "close", tabId });
  return response !== null && response.ok;
}

export async function navigateGlobal(url: string, tabId?: string): Promise<boolean> {
  const response = await postGlobal("navigate", tabId ? { url, tabId } : { url });
  return response !== null && response.ok;
}

export async function placeGlobal(visible: boolean, bounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): Promise<void> {
  await postGlobal("place", visible && bounds
    ? { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height), visible: true }
    : { visible: false });
}

export async function restoreClosedGlobalTabs(): Promise<boolean> {
  const response = await postGlobal("restore-closed-tabs", {});
  return response !== null && response.ok;
}

export async function dismissClosedGlobalTabs(): Promise<boolean> {
  const response = await postGlobal("dismiss-closed-tabs", {});
  return response !== null && response.ok;
}

/**
 * 같은 주소의 탭이 이미 있으면 그 탭으로 가고, 없으면 새 탭을 연다.
 * 링크 클릭이 탭을 중복으로 불리지 않게 한다.
 *
 * 뒤 탭(`activate: false`)은 활성 탭을 바꾸지 않는다(브라우저 관례). 탭이 하나도
 * 없을 때의 첫 뒤 탭은 활성이 된다. 같은 주소 탭이 이미 있으면 그대로 둔다.
 */
export async function focusOrCreateGlobalTab(url: string, options?: { readonly activate?: boolean }): Promise<boolean> {
  const foreground = options?.activate !== false;
  try {
    const current = await getGlobalState();
    const existing = current?.tabs.find((tab) => tab.url === url);
    if (existing) {
      if (!foreground) return true;
      const moved = await selectGlobalTab(existing.id);
      if (moved) return true;
    } else if (!foreground && current && current.tabs.length > 0) {
      const previous = current.activeTabId;
      const created = await createGlobalTab(url);
      if (!created) return false;
      // 새로 난 탭이 앞선 순서로 활성이 되므로, 보던 탭을 앞자리로 되돌린다.
      if (previous) await selectGlobalTab(previous).catch(() => false);
      return true;
    }
  } catch {
    // 출발점 읽기에 실패하면 만들기로 떨어진다.
  }
  return createGlobalTab(url);
}

// ---------- shared 폴백 안내(세션당 한 번) ----------

let sharedFallbackShown = false;
let sharedFallbackVisible = false;
const sharedFallbackListeners = new Set<() => void>();

function emitSharedFallback(): void {
  for (const listener of sharedFallbackListeners) listener();
}

function subscribeSharedFallback(listener: () => void): () => void {
  sharedFallbackListeners.add(listener);
  return () => { sharedFallbackListeners.delete(listener); };
}

/** Desktop shared 중 링크를 내 브라우저로 열 때 처음 한 번 안내를 세운다. */
export function notifySharedFallback(): void {
  if (sharedFallbackShown) return;
  sharedFallbackShown = true;
  sharedFallbackVisible = true;
  emitSharedFallback();
}

export function dismissSharedFallback(): void {
  if (!sharedFallbackVisible) return;
  sharedFallbackVisible = false;
  emitSharedFallback();
}

export function useSharedFallbackNotice(): boolean {
  return React.useSyncExternalStore(subscribeSharedFallback, () => sharedFallbackVisible, () => false);
}

export async function setGlobalViewport(preset: "responsive" | "mobile" | "tablet"): Promise<boolean> {
  const response = await postGlobal("viewport", { preset });
  return response !== null && response.ok;
}

export async function setGlobalColorScheme(colorScheme: "light" | "dark"): Promise<boolean> {
  const response = await postGlobal("viewport", { colorScheme });
  return response !== null && response.ok;
}

export async function chooseGlobalProfile(profile: string | null): Promise<boolean> {
  const response = await postGlobal("profile", { profile });
  return response !== null && response.ok;
}

export async function clearGlobalProfile(): Promise<boolean> {
  // 비울 영속 프로필을 이름으로 보낸다 — 라우트가 profile 문자열을 요구한다(Operation 패널과 같은 id).
  const response = await postGlobal("clear-profile", { profile: "default" });
  return response !== null && response.ok;
}

/**
 * Chrome 프로필의 쿠키를 전역 브라우저가 지금 쓰는 세션에 넣는다. 성공하면 넣은 수를, 실패하면 사람에게 보일 까닭을 돌려준다
 * (서버가 준 `message` — Chrome 이 없거나 복사본을 못 열었다는 말이 그대로 온다).
 */
export async function importGlobalFromChrome(profileId: string): Promise<{ readonly cookies: number } | { readonly error: string | null }> {
  const response = await postGlobal("import", { profileId });
  if (response === null) return { error: null };
  try {
    const body = await response.json() as { cookies?: unknown; message?: unknown };
    if (response.ok && typeof body.cookies === "number") return { cookies: body.cookies };
    return { error: typeof body.message === "string" ? body.message : null };
  } catch { return { error: null }; }
}
