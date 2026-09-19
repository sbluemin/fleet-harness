import { useSyncExternalStore } from "react";

type Listener = () => void;

let snapshot = false;
const listeners = new Set<Listener>();

export function useDesktopFullscreenSnapshot(): boolean {
  return useSyncExternalStore(subscribe, getDesktopFullscreenSnapshot, getDesktopFullscreenSnapshot);
}

export function getDesktopFullscreenSnapshot(): boolean {
  return snapshot;
}

export function applyDesktopFullscreenSnapshot(value: unknown): void {
  snapshot = isDesktopFullscreenSnapshot(value) ? value.fullscreen : false;
  for (const listener of listeners) listener();
}

export function resetDesktopFullscreenSnapshot(): void {
  applyDesktopFullscreenSnapshot({ fullscreen: false });
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function isDesktopFullscreenSnapshot(value: unknown): value is { readonly fullscreen: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return Object.keys(entry).length === 1 && typeof entry.fullscreen === "boolean";
}
