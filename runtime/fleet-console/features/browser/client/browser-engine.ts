import * as React from "react";

/**
 * 플릿 브라우저의 크롬(주소줄·탭 레일·메뉴·주석)은 Desktop 셸이 그린다. 이 모듈이 아는 것은 Console 쪽에 남은 두 가지뿐이다:
 * 이 Console 에서 브라우저를 열 수 있는가(지구본이 읽는다), 그리고 Desktop 이 넘긴 이미지를 받을 입력창 손잡이.
 */

// ---------- 플러그인 대화의 스크린샷 첨부 ----------

/**
 * 지금 보는 플러그인 대화(사령관 등)의 입력창 손잡이. 이 대화는 활성 Objective 가 아니라서 분리 창이 Objective 로는 첨부 대상을 찾지 못한다 —
 * 대화 칸(ConversationStage)이 그 대화가 서 있는 동안만 여기에 올리고, 떠나면 거둔다. 분리 창은 활성 Objective 가 없을 때만 이것을 쓴다.
 */
let pluginAttach: ((files: readonly File[]) => void) | null = null;
const pluginAttachListeners = new Set<() => void>();

/** 올린 손잡이를 돌려준다 — 거둘 때는 자기가 올린 것일 때만 비운다(다른 대화가 이미 바꿔 놓았으면 그대로 둔다). */
export function publishBrowserPluginAttach(attach: (files: readonly File[]) => void): () => void {
  pluginAttach = attach;
  for (const listener of pluginAttachListeners) listener();
  return () => {
    if (pluginAttach !== attach) return;
    pluginAttach = null;
    for (const listener of pluginAttachListeners) listener();
  };
}

const subscribePluginAttach = (listener: () => void) => { pluginAttachListeners.add(listener); return () => { pluginAttachListeners.delete(listener); }; };

export function useBrowserPluginAttach(): ((files: readonly File[]) => void) | null {
  return React.useSyncExternalStore(subscribePluginAttach, () => pluginAttach, () => null);
}

// ---------- 브라우저를 열 수 있는가 ----------

/**
 * 못 여는 까닭. `desktop_required` 는 관리 Desktop 이 없거나 그 연결이 끊긴 것이다.
 * 어느 화면인지는 `surfaceMode` 가 말한다 — 웹·원격·비관리 창도 보기 전용으로 연다.
 */
export type BrowserUnavailableReason = "desktop_required";
export type BrowserSurfaceMode = "native" | "viewer";
export interface BrowserExecutionHost {
  readonly managed: boolean;
  readonly connected: boolean;
  readonly status: "connected" | "manager_disconnected" | "unmanaged";
  readonly hostLabel: string | null;
  readonly platform: "darwin" | "win32" | "linux" | null;
  readonly accessPath: "loopback" | "wsl" | null;
}
/** 아직 묻지 않았거나 답을 못 받았으면 null — 그때는 문을 닫지 않는다(모르는 것을 못 쓰는 것으로 보이지 않게). */
export type BrowserEngineState = {
  readonly available: boolean;
  readonly reason?: BrowserUnavailableReason;
  readonly surfaceMode: BrowserSurfaceMode;
  readonly executionHost: BrowserExecutionHost;
} | null;

const UNMANAGED_HOST: BrowserExecutionHost = { managed: false, connected: false, status: "unmanaged", hostLabel: null, platform: null, accessPath: null };

let engineState: BrowserEngineState = null;
let engineAskedAt = 0;
let engineInflight: Promise<void> | null = null;
const engineListeners = new Set<() => void>();
/** 패널이 열려 있지 않은 동안에도 다른 화면이 붙었다 떠난 사실을 글리프가 따라가는 간격. */
const ENGINE_RECHECK_MS = 10_000;

function isDesktopShellDocument(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.desktopShell === "true";
}

function sameEngine(current: BrowserEngineState, next: Exclude<BrowserEngineState, null>): boolean {
  if (current === null) return false;
  return current.available === next.available && current.reason === next.reason && current.surfaceMode === next.surfaceMode
    && current.executionHost.status === next.executionHost.status && current.executionHost.hostLabel === next.executionHost.hostLabel
    && current.executionHost.accessPath === next.executionHost.accessPath && current.executionHost.connected === next.executionHost.connected;
}

/** 스트림으로 같은 사실을 들은 쪽(패널)이 알려 준다 — 글리프가 다음 물음까지 기다리지 않게. */
export function publishBrowserEngine(next: Exclude<BrowserEngineState, null>): void {
  if (sameEngine(engineState, next)) return;
  engineState = next;
  for (const listener of engineListeners) listener();
}

export function readBrowserEngineBody(body: { readonly available?: unknown; readonly reason?: unknown; readonly surfaceMode?: unknown; readonly executionHost?: Partial<BrowserExecutionHost> | null }): Exclude<BrowserEngineState, null> | null {
  if (typeof body.available !== "boolean") return null;
  const reported = body.executionHost;
  const executionHost: BrowserExecutionHost = reported && (reported.status === "connected" || reported.status === "manager_disconnected" || reported.status === "unmanaged")
    ? {
      managed: reported.managed === true,
      connected: reported.connected === true,
      status: reported.status,
      hostLabel: typeof reported.hostLabel === "string" ? reported.hostLabel : null,
      platform: reported.platform === "darwin" || reported.platform === "win32" || reported.platform === "linux" ? reported.platform : null,
      accessPath: reported.accessPath === "loopback" || reported.accessPath === "wsl" ? reported.accessPath : null,
    }
    : body.available ? { ...UNMANAGED_HOST, managed: true, connected: true, status: "connected" } : UNMANAGED_HOST;
  const surfaceMode: BrowserSurfaceMode = body.surfaceMode === "native" || body.surfaceMode === "viewer"
    ? body.surfaceMode
    : isDesktopShellDocument() ? "native" : "viewer";
  return body.available ? { available: true, surfaceMode, executionHost } : { available: false, reason: "desktop_required", surfaceMode, executionHost };
}

export function refreshBrowserEngine(): void { void (engineInflight ?? Promise.resolve()).then(() => askEngine()); }

function askEngine(): void {
  // 웹·모바일·원격도 서버의 surfaceMode 를 따른다. Desktop 이 아니라는 이유만으로 막지 않는다.
  if (engineInflight || typeof fetch !== "function") return;
  engineAskedAt = Date.now();
  engineInflight = fetch("/api/v1/browser")
    .then(async (response) => {
      if (!response.ok) return;
      const next = readBrowserEngineBody(await response.json() as { available?: unknown; surfaceMode?: unknown; executionHost?: Partial<BrowserExecutionHost> | null });
      if (next) publishBrowserEngine(next);
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
