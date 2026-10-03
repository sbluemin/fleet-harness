import { useSyncExternalStore } from "react";

export type MobileTab = "operations" | "tools" | "alerts";
export type MobileTool = { readonly kind: "rail"; readonly id: string } | { readonly kind: "surface"; readonly instanceId: string };
let activeTool: MobileTool | null = null;

export function useMobileTool(): MobileTool | null {
  return useSyncExternalStore(subscribe, () => activeTool);
}

/** 도구 시트의 선택만 보관한다. 본문·PTY의 수명은 기존 페인/표면 소유자가 지킨다. */
export function setMobileTool(next: MobileTool | null): void {
  activeTool = next;
  if (next !== null) setMobileTab("tools");
  for (const listener of listeners) listener();
}

const STORAGE_KEY = "fleet-console.mobile.activeTab";
const listeners = new Set<() => void>();
let activeTab = readStoredTab();
let sessionOpen = false;

export function useMobileTab(): MobileTab {
  return useSyncExternalStore(subscribe, () => activeTab);
}

/**
 * True while an operation fills the layout. The tab bar lives above the routes, so the shell that
 * opens an operation reports it here rather than hiding a bar it does not own.
 */
export function useMobileSessionOpen(): boolean {
  return useSyncExternalStore(subscribe, () => sessionOpen);
}

export function setMobileSessionOpen(next: boolean): void {
  if (sessionOpen === next) return;
  sessionOpen = next;
  for (const listener of listeners) listener();
}

export function setMobileTab(next: MobileTab): void {
  if (activeTab === next) return;
  activeTab = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* storage is optional */ }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readStoredTab(): MobileTab {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "alerts" || stored === "tools") return stored;
  } catch { /* storage is optional */ }
  return "operations";
}
