import { useSyncExternalStore } from "react";

import type { DiffFileEntry } from "../server/types.js";

// ─── types ───────────────────────────────────────────────────────────────────

export interface SelectedFile {
  readonly entry: DiffFileEntry;
  readonly theaterId: string;
}

interface DiffViewState {
  readonly file: SelectedFile | null;
}

type Listener = () => void;

// ─── constants ───────────────────────────────────────────────────────────────

const listeners = new Set<Listener>();

let state: DiffViewState = { file: null };

// ─── functions ───────────────────────────────────────────────────────────────

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): DiffViewState {
  return state;
}

export function useSelectedFile(theaterId: string | null): SelectedFile | null {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!s.file || s.file.theaterId !== theaterId) return null;
  return s.file;
}

export function setSelectedFile(entry: DiffFileEntry, theaterId: string): void {
  state = { file: { entry, theaterId } };
  emit();
}

export function clearSelectedFile(): void {
  state = { file: null };
  emit();
}
