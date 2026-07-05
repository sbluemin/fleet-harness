import { useSyncExternalStore } from "react";

import type { DiffFileEntry, LogCommitEntry } from "../server/types.js";

// ─── types ───────────────────────────────────────────────────────────────────

export interface SelectedFile {
  readonly entry: DiffFileEntry;
  readonly theaterId: string;
  // 선택 시점의 subPath — 저장소가 바뀌면 선택을 초기화하는 데 사용
  readonly subPath: string;
}

export interface SelectedCommit {
  readonly commit: LogCommitEntry;
  readonly subPath: string;
  readonly theaterId: string;
}

interface DiffViewState {
  readonly file: SelectedFile | null;
  readonly commit: SelectedCommit | null;
}

type Listener = () => void;

// ─── constants ───────────────────────────────────────────────────────────────

const listeners = new Set<Listener>();

let state: DiffViewState = { file: null, commit: null };

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

export function useSelectedCommit(theaterId: string | null): SelectedCommit | null {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!s.commit || s.commit.theaterId !== theaterId) return null;
  return s.commit;
}

export function setSelectedFile(entry: DiffFileEntry, subPath: string, theaterId: string): void {
  state = { file: { entry, subPath, theaterId }, commit: null };
  emit();
}

export function setSelectedCommit(commit: LogCommitEntry, subPath: string, theaterId: string): void {
  state = { file: null, commit: { commit, subPath, theaterId } };
  emit();
}

export function clearSelectedFile(): void {
  state = { file: null, commit: state.commit };
  emit();
}

export function clearSelectedCommit(): void {
  state = { file: state.file, commit: null };
  emit();
}
