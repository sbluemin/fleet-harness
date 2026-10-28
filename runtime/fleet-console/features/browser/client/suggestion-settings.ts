import { useEffect, useSyncExternalStore } from "react";
import type { BrowserSuggestionSettings } from "../shared/suggestions.js";

const endpoint = "/api/v1/browser/suggestion-settings";
const listeners = new Set<() => void>();
let snapshot: { settings: BrowserSuggestionSettings | null; saving: boolean; failed: boolean } = { settings: null, saving: false, failed: false };
let generation = 0;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const getSnapshot = () => snapshot;
function publish(next: typeof snapshot) { snapshot = next; listeners.forEach((listener) => listener()); }

async function readSettings(response: Response): Promise<BrowserSuggestionSettings> {
  if (!response.ok) throw new Error("suggestion_settings_failed");
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || !("enabled" in data) || typeof data.enabled !== "boolean" || !("prompted" in data) || typeof data.prompted !== "boolean") throw new Error("invalid_suggestion_settings");
  return { enabled: data.enabled, prompted: data.prompted };
}

export async function loadSuggestionSettings(): Promise<void> {
  if (snapshot.saving) return;
  const current = ++generation;
  try {
    const settings = await readSettings(await fetch(endpoint, { cache: "no-store" }));
    if (current === generation) publish({ settings, saving: false, failed: false });
  } catch {
    if (current === generation) publish({ settings: null, saving: false, failed: true });
  }
}

export async function saveSuggestionSettings(enabled: boolean): Promise<void> {
  if (snapshot.saving) return;
  ++generation;
  publish({ ...snapshot, saving: true, failed: false });
  try {
    const settings = await readSettings(await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) }));
    publish({ settings, saving: false, failed: false });
  } catch {
    publish({ ...snapshot, saving: false, failed: true });
  }
}

export function useSuggestionSettings() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    void loadSuggestionSettings();
    const refresh = () => { void loadSuggestionSettings(); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  return state;
}
