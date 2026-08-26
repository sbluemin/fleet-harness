import { useSyncExternalStore } from "react";

export type MobileTab = "operations" | "alerts" | "skills";

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
    // "tools" was a tab before settings replaced it; a stored one falls back to operations.
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "alerts" || stored === "skills") return stored;
  } catch { /* storage is optional */ }
  return "operations";
}
