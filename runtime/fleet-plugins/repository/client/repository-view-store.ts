import { useSyncExternalStore } from "react";

import type { DiffFileEntry } from "../server/types.js";

// ─── types ───────────────────────────────────────────────────────────────────

export interface SelectedFile {
  readonly entry: DiffFileEntry;
  readonly theaterId: string;
  readonly repoRel: string;
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

export function getSelectedFile(theaterId: string | null, repoRel: string): SelectedFile | null {
  if (!state.file || state.file.theaterId !== theaterId || state.file.repoRel !== repoRel) return null;
  return state.file;
}

export function useSelectedFile(theaterId: string | null, repoRel: string): SelectedFile | null {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!s.file || s.file.theaterId !== theaterId || s.file.repoRel !== repoRel) return null;
  return s.file;
}

export function setSelectedFile(entry: DiffFileEntry, theaterId: string, repoRel: string): void {
  state = { file: { entry, theaterId, repoRel } };
  emit();
}

export function clearSelectedFile(): void {
  state = { file: null };
  emit();
}
