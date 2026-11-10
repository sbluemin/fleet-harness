import * as React from "react";
import type { DesktopBrowserSurface } from "@fleet-console/protocol/desktop";
import { DESKTOP_BROWSER_DEFAULT_SPACE_ID, DESKTOP_BROWSER_SURFACE_CAPABILITY } from "@fleet-console/protocol/desktop";
import { desktopShellCapabilities } from "../../../core/client/src/integration/desktop-shell.js";
import { subscribeConsoleChannel } from "../../../core/client/src/integration/objective-records-sse.js";
import { BROWSER_GLOBAL_ID } from "../shared/browser-id.js";

/**
 * 플릿 브라우저 표면(메인 창 오른쪽 칸 또는 독립 창)의 Console 쪽 손잡이. 표면 자체 — 크롬·레이아웃·입력 — 은 Desktop 셸이 그리고 소유한다.
 * Console 은 "열려 있는가"를 `browser:state` 로 듣고, 열고 닫는 요청을 서버에 보낼 뿐이다(서버가 lease 를 쥔다).
 */

const endpoint = `/api/v1/browser/objectives/${encodeURIComponent(BROWSER_GLOBAL_ID)}`;
const BROWSER_STATE_EVENT = "browser:state";

let current: DesktopBrowserSurface | null = null;
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

function publish(next: DesktopBrowserSurface | null): void {
  if (current?.id === next?.id && current?.mode === next?.mode) return;
  current = next;
  markDockedPane(next);
  for (const listener of listeners) listener();
}

function receive(payload: unknown): void {
  const frame = payload as { browserId?: unknown; surface?: DesktopBrowserSurface | null } | null;
  if (!frame || frame.browserId !== BROWSER_GLOBAL_ID) return;
  publish(frame.surface ?? null);
}

/** 상태 스트림은 이미 열려 있는 Console 스트림을 탄다 — 구독이 시작될 때 출발점을 한 번 읽는다. */
function start(): void {
  if (started) return;
  started = true;
  subscribeConsoleChannel(BROWSER_STATE_EVENT, receive);
  void fetch(`${endpoint}/state`).then(async (response) => {
    if (!response.ok) return;
    const body = await response.json() as { surface?: DesktopBrowserSurface | null };
    if (current === null) publish(body.surface ?? null);
  }).catch(() => undefined);
}

const subscribe = (listener: () => void) => { start(); listeners.add(listener); return () => { listeners.delete(listener); }; };

/** 지금 열려 있는 표면. 없으면 null. */
export function useBrowserSurface(): DesktopBrowserSurface | null {
  return React.useSyncExternalStore(subscribe, () => current, () => null);
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
 * CLI·채팅에서 고른 주소를 브라우저로 연다. 표면을 열고, 링크는 디폴트 스페이스의 새 탭에서 — 사람이 거기서 보던 빈 탭만 그 자리에서 쓴다(사람이 보던 페이지를 링크 하나가 밀어내지 않게).
 * 표면 안의 화면은 Desktop 이 그리므로 이 요청은 서버의 탭 REST 로 곧장 간다.
 */
export async function openBrowserLink(url: string): Promise<void> {
  openBrowserPane();
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
}
