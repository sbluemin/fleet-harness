import { React } from "@fleet-console/sdk/plugin/browser";

/**
 * 패널 ↔ 캡션 공유 — companion 의 캡션과 본문은 호스트가 따로 그리므로, 본문(BrowserPanel)이 자기 상태와
 * 손잡이를 여기 올리고 캡션(BrowserCaption)이 읽는다. 탭 스트립이 캡션 밴드에 살기 위한 다리다.
 */

export interface BrowserCaptionTab { readonly id: string; readonly url: string; readonly title: string; readonly favicon: string | null; readonly loading: boolean }
export interface BrowserPanelSnapshot {
  readonly tabs: readonly BrowserCaptionTab[];
  readonly activeTabId: string | null;
  readonly driving: boolean;
  readonly viewport: { readonly width: number; readonly height: number; readonly preset: "responsive" | "mobile" | "tablet"; readonly setBy: "user" | "agent" | null } | null;
  readonly busy: boolean;
  /** 지금 이 Console 에서 브라우저를 열 수 있는가 — 아니면 캡션의 문(새 탭·뷰포트)도 닫힌다. */
  readonly available: boolean;
  readonly actions: {
    readonly selectTab: (tabId: string) => void;
    readonly closeTab: (tabId: string) => void;
    readonly createTab: () => void;
    readonly openImport: () => void;
    readonly setViewport: (preset: "responsive" | "mobile" | "tablet") => void;
  };
}

const snapshots = new Map<string, BrowserPanelSnapshot>();
const listeners = new Map<string, Set<() => void>>();

export function publishBrowserPanel(operationId: string, snapshot: BrowserPanelSnapshot | null): void {
  if (snapshot) snapshots.set(operationId, snapshot); else snapshots.delete(operationId);
  for (const listener of listeners.get(operationId) ?? []) listener();
}

export function useBrowserPanel(operationId: string): BrowserPanelSnapshot | null {
  const subscribe = React.useCallback((listener: () => void) => {
    const set = listeners.get(operationId) ?? new Set<() => void>();
    set.add(listener); listeners.set(operationId, set);
    return () => { set.delete(listener); if (set.size === 0) listeners.delete(operationId); };
  }, [operationId]);
  return React.useSyncExternalStore(subscribe, () => snapshots.get(operationId) ?? null, () => null);
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

/** 이 Console 에서 브라우저를 열 수 있는지. 캡션의 지구본 문은 이것으로 닫히고 열린다. */
export function useBrowserEngine(): BrowserEngineState {
  return React.useSyncExternalStore(subscribeEngine, () => engineState, () => null);
}
