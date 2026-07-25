import { useSyncExternalStore } from "react";

export type MobileTab = "operations" | "alerts" | "tools";

const STORAGE_KEY = "fleet-console.mobile.activeTab";
const listeners = new Set<() => void>();
let activeTab = readStoredTab();

export function useMobileTab(): MobileTab {
  return useSyncExternalStore(subscribe, () => activeTab);
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
