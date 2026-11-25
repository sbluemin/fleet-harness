import * as React from "react";
import type { DesktopBrowserSurface } from "@fleet-console/protocol/desktop";
import { commodoreBrowserSpaceId, DESKTOP_BROWSER_DEFAULT_SPACE_ID, DESKTOP_BROWSER_REMOTE_CONTROL_CAPABILITY, DESKTOP_BROWSER_SURFACE_CAPABILITY, DESKTOP_WINDOW_COMMAND_PATH } from "@fleet-console/protocol/desktop";
import { desktopShellCapabilities, isDesktopShell } from "../../../core/client/src/integration/desktop-shell.js";
import { subscribeConsoleChannel } from "../../../core/client/src/integration/objective-records-sse.js";
import { BROWSER_GLOBAL_ID } from "../shared/browser-id.js";
import { getBrowserEngineSnapshot } from "./browser-engine.js";
import { toggleBrowserViewerShell } from "./browser-viewer-shell.js";

/**
 * 플릿 브라우저 표면(메인 창 오른쪽 칸 또는 독립 창)의 Console 쪽 손잡이. 표면 자체 — 크롬·레이아웃·입력 — 은 Desktop 셸이 그리고 소유한다.
 * Console 은 "열려 있는가"를 `browser:state` 로 듣고, 열고 닫는 요청을 서버에 보낼 뿐이다(서버가 lease 를 쥔다).
 */

const endpoint = `/api/v1/browser/objectives/${encodeURIComponent(BROWSER_GLOBAL_ID)}`;
const BROWSER_STATE_EVENT = "browser:state";
const COMMODORE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let current: DesktopBrowserSurface | null = null;
/** 에이전트가 이 Console 의 브라우저를 쓰고 있는가 — 사이드바 버튼의 aurora 신호가 읽는다. */
let driving = false;
/** 지금 열린 탭 수 — 닫힌 줄이 「탭 N」을 말한다. */
let tabCount = 0;
/** 마지막으로 닫힌 순간의 탭 수. 열려 있거나 연 적이 없으면 null 이다. */
let closedTabs: number | null = null;
const listeners = new Set<() => void>();
let started = false;

/**
 * 칸이 메인 창 오른쪽에 붙어 있는가를 문서 루트에 남긴다. Windows 에서는 창의 캡션 버튼(최소화·최대화·닫기)이 그 칸의 맨 위 줄 끝에 서므로,
 * Console 의 맨 위 줄이 캡션 자리를 비울 까닭이 없다 — conversation.css·layout.css 의 캡션 예약이 이 표식을 읽고 물러난다.
 * 독립 창이거나 표면이 없으면 캡션 버튼은 Console 위에 그대로 서 있으므로 표식을 걷는다.
 */
function markDockedPane(next: DesktopBrowserSurface | null): void {
  if (typeof document === "undefined") return;
  if (next?.mode === "pane") document.documentElement.setAttribute("data-browser-pane", "true");
  else document.documentElement.removeAttribute("data-browser-pane");
}

function sameSurface(left: DesktopBrowserSurface | null, right: DesktopBrowserSurface | null): boolean {
  if (left === null || right === null) return left === right;
  return left.id === right.id && left.mode === right.mode;
}

function publish(next: DesktopBrowserSurface | null, meta?: { readonly driving: boolean; readonly tabCount: number }): void {
  const previous = current;
  const nextDriving = meta?.driving ?? driving;
  const nextTabs = meta?.tabCount ?? tabCount;
  if (previous !== null && next !== null && sameSurface(previous, next) && nextDriving === driving && nextTabs === tabCount) return;
  if (previous === null && next === null && nextDriving === driving && nextTabs === tabCount) return;
  current = next;
  driving = nextDriving;
  tabCount = nextTabs;
  if (next !== null) {
    closedTabs = null;
  } else if (previous !== null) {
    closedTabs = nextTabs;
  }
  markDockedPane(next);
  for (const listener of listeners) listener();
}

function readMeta(frame: { readonly driving?: unknown; readonly tabs?: unknown }): { driving: boolean; tabCount: number } {
  return { driving: frame.driving === true, tabCount: Array.isArray(frame.tabs) ? frame.tabs.length : 0 };
}

function receive(payload: unknown): void {
  const frame = payload as { browserId?: unknown; surface?: DesktopBrowserSurface | null; driving?: unknown; tabs?: unknown } | null;
  if (!frame || frame.browserId !== BROWSER_GLOBAL_ID) return;
  publish(frame.surface ?? null, readMeta(frame));
}

/** 상태 스트림은 이미 열려 있는 Console 스트림을 탄다 — 구독이 시작될 때 출발점을 한 번 읽는다. */
function start(): void {
  if (started) return;
  started = true;
  subscribeConsoleChannel(BROWSER_STATE_EVENT, receive);
  void fetch(`${endpoint}/state`).then(async (response) => {
    if (!response.ok) return;
    const body = await response.json() as { surface?: DesktopBrowserSurface | null; driving?: unknown; tabs?: unknown };
    if (current === null) publish(body.surface ?? null, readMeta(body));
  }).catch(() => undefined);
}

const subscribe = (listener: () => void) => { start(); listeners.add(listener); return () => { listeners.delete(listener); }; };

/** 지금 열려 있는 표면. 없으면 null. */
export function useBrowserSurface(): DesktopBrowserSurface | null {
  return React.useSyncExternalStore(subscribe, () => current, () => null);
}

/** 에이전트가 이 Console 의 브라우저를 쓰고 있는가 — 사이드바 버튼의 aurora 신호. */
export function useBrowserDriving(): boolean {
  return React.useSyncExternalStore(subscribe, () => driving, () => false);
}

/** 지금 열린 탭 수. 닫힌 뒤에도 마지막 수를 남긴다 — 「다시 열기」 줄이 그 수를 말한다. */
export function useBrowserTabCount(): number {
  return React.useSyncExternalStore(subscribe, () => tabCount, () => 0);
}

/** 브라우저가 닫혔고 그때 탭이 남아 있었으면 그 수, 아니면 null. 한 번의 닫힘에 한 줄만 서게 한다. */
export function useBrowserClosedTabs(): number | null {
  return React.useSyncExternalStore(subscribe, () => closedTabs, () => null);
}

async function request(action: "open" | "close" | "focus" | "mode", id?: string, mode?: "pane" | "window"): Promise<DesktopBrowserSurface | null> {
  const response = await fetch(`${endpoint}/surface`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, id, mode }) });
  if (!response.ok) throw new Error("browser_surface_failed");
  const body = await response.json() as { surface?: DesktopBrowserSurface | null };
  publish(body.surface ?? null);
  return body.surface ?? null;
}

/** 열려 있는 독립 창을 앞으로 부른다. 표면이 없거나 칸이면 아무것도 하지 않고 false. */
export function focusBrowserWindow(): boolean {
  if (current?.mode !== "window") return false;
  void request("focus", current.id).catch(() => undefined);
  return true;
}

/** 지구본·링크는 기본 셸 칸을 연다. 표면 능력이 없는 옛 셸에서는 열리지 않는다(브라우저 문이 닫혀 있다). */
export function openBrowserPane(): void {
  if (focusBrowserWindow() || current) return;
  if (!desktopShellCapabilities().includes(DESKTOP_BROWSER_SURFACE_CAPABILITY)) return;
  void request("open", undefined, "pane").catch(() => undefined);
}

export function closeBrowserSurface(): void {
  if (current) void request("close", current.id).catch(() => undefined);
}

export function toggleBrowserPane(): void {
  if (current?.mode === "window") { void request("focus", current.id).catch(() => undefined); return; }
  if (current) closeBrowserSurface(); else openBrowserPane();
}

/**
 * 좌측 사이드바에서 사령관·지휘관을 골랐을 때 플릿 브라우저를 그 사령관 스페이스로 옮긴다. 열려 있으면 곧바로 옮기고,
 * 닫혀 있으면 열지 않은 채 셸이 기억했다가 다음에 열 때 그 스페이스로 연다 — 그래서 닫혀 있어도 요청을 보낸다.
 */
export function selectBrowserSpaceForCommodore(commodoreId: string): void {
  if (!COMMODORE_UUID.test(commodoreId) || !isDesktopShell() || typeof fetch !== "function") return;
  void fetch(DESKTOP_WINDOW_COMMAND_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "select-browser-space", spaceId: commodoreBrowserSpaceId(commodoreId) }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => undefined);
}

/**
 * CLI·채팅에서 고른 주소를 브라우저로 연다. 표면을 열고, 링크는 디폴트 스페이스의 새 탭에서 — 사람이 거기서 보던 빈 탭만 그 자리에서 쓴다(사람이 보던 페이지를 링크 하나가 밀어내지 않게).
 * 표면 안의 화면은 Desktop 이 그리므로 이 요청은 서버의 탭 REST 로 곧장 간다.
 *
 * 원격 조작 Desktop(`remote`)의 브라우저는 관리 표면이 아니라 그 셸이 그리는 원격 셸이다. 관리 표면 요청은 거절되므로
 * 탭을 연 뒤 그 셸이 닫혀 있을 때만 창 명령으로 연다 — 그러지 않으면 링크는 실행 측 기계에서만 열리고 보는 화면에는 아무 일도 없다.
 */
export async function openBrowserLink(url: string): Promise<void> {
  const remote = getBrowserEngineSnapshot()?.surfaceMode === "remote";
  if (!remote) openBrowserPane();
  try {
    const stateResponse = await fetch(`${endpoint}/state`);
    const state = stateResponse.ok ? await stateResponse.json() as { activeTabId?: string | null; tabs?: { id: string; url: string; spaceId: string }[] } : null;
    const active = state?.tabs?.find((tab) => tab.id === state.activeTabId) ?? null;
    const intoActive = active === null || (active.url === "about:blank" && active.spaceId === DESKTOP_BROWSER_DEFAULT_SPACE_ID);
    await fetch(`${endpoint}/${intoActive ? "navigate" : "tabs"}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(intoActive ? { url } : { action: "create", url }),
    });
  } catch { /* 열리지 않은 링크는 다음 시도에서 다시 연다 */ }
  if (remote) await revealRemoteBrowser();
}

/** 원격 셸이 열려 있지 않으면 연다. 셸은 여닫기 명령만 받으므로, 열려 있는지는 서버가 그 셸의 투영 구독으로 답한다. */
async function revealRemoteBrowser(): Promise<void> {
  if (!isDesktopShell() || !desktopShellCapabilities().includes(DESKTOP_BROWSER_REMOTE_CONTROL_CAPABILITY)) return;
  try {
    const response = await fetch("/api/v1/browser");
    if (!response.ok) return;
    const body = await response.json() as { viewerOpen?: unknown };
    if (body.viewerOpen === true) return;
  } catch { return; }
  toggleBrowserViewerShell();
}
