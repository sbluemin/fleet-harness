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

// ---------- 엔진 유무 ----------

export type BrowserEngineMissingReason = "env_invalid" | "wsl_windows_node_missing" | "wsl_missing" | "missing";
/** 아직 묻지 않았거나 답을 못 받았으면 null — 그때는 문을 닫지 않는다(모르는 것을 못 쓰는 것으로 보이지 않게). */
export type BrowserEngineState = { readonly available: true } | { readonly available: false; readonly reason: BrowserEngineMissingReason } | null;

let engineState: BrowserEngineState = null;
let engineAskedAt = 0;
let engineInflight: Promise<void> | null = null;
const engineListeners = new Set<() => void>();
const ENGINE_RECHECK_MS = 30_000;

function askEngine(): void {
  if (engineInflight || typeof fetch !== "function") return;
  engineAskedAt = Date.now();
  engineInflight = fetch("/api/v1/browser")
    .then(async (response) => {
      if (!response.ok) return;
      const body = await response.json() as { readonly available?: unknown; readonly missingReason?: unknown };
      if (typeof body.available !== "boolean") return;
      const reason = typeof body.missingReason === "string" ? body.missingReason as BrowserEngineMissingReason : "missing";
      const next: BrowserEngineState = body.available ? { available: true } : { available: false, reason };
      if (engineState?.available === next.available && (next.available || (engineState && !engineState.available && engineState.reason === reason))) return;
      engineState = next;
      for (const listener of engineListeners) listener();
    })
    .catch(() => undefined)
    .finally(() => { engineInflight = null; });
}

function subscribeEngine(listener: () => void): () => void {
  engineListeners.add(listener);
  if (engineListeners.size === 1) askEngine();
  // 설치하고 돌아온 사람에게 다시 묻는다 — 탭이 눈에 들어올 때, 30초에 한 번.
  const onVisible = () => { if (document.visibilityState === "visible" && Date.now() - engineAskedAt > ENGINE_RECHECK_MS) askEngine(); };
  document.addEventListener("visibilitychange", onVisible);
  return () => { engineListeners.delete(listener); document.removeEventListener("visibilitychange", onVisible); };
}

/** 이 Console 이 브라우저 엔진을 띄울 수 있는지. 캡션의 지구본 문은 이것으로 닫히고 열린다. */
export function useBrowserEngine(): BrowserEngineState {
  return React.useSyncExternalStore(subscribeEngine, () => engineState, () => null);
}
