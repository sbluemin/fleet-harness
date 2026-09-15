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
    readonly interrupt: () => void;
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
