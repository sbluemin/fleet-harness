import { useSyncExternalStore } from "react";

import type { DiffFileEntry } from "../server/types.js";

// ─── types ───────────────────────────────────────────────────────────────────

export interface SelectedFile {
  readonly entry: DiffFileEntry;
  readonly theaterId: string;
  // 선택 시점의 subPath — 저장소가 바뀌면 선택을 초기화하는 데 사용
  readonly subPath: string;
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

export function useSelectedFile(theaterId: string | null, subPath: string): SelectedFile | null {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!s.file || s.file.theaterId !== theaterId || s.file.subPath !== subPath) return null;
  return s.file;
}

export function setSelectedFile(entry: DiffFileEntry, subPath: string, theaterId: string): void {
  state = { file: { entry, subPath, theaterId } };
  emit();
}

export function clearSelectedFile(): void {
  state = { file: null };
  emit();
}
