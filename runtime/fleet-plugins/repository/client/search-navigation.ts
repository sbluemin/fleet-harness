import { useSyncExternalStore } from "react";

export interface RepositorySearchTarget {
  readonly theaterId: string;
  readonly repoRel: string;
  readonly fullHash: string;
  readonly requestId: number;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let requestId = 0;
let target: RepositorySearchTarget | null = null;

export function activateRepositorySearchTarget(theaterId: string, repoRel: string, fullHash: string): void {
  target = { theaterId, repoRel, fullHash, requestId: ++requestId };
  emit();
}

export function consumeRepositorySearchTarget(expected: RepositorySearchTarget): void {
  if (target?.requestId !== expected.requestId) return;
  target = null;
  emit();
}

export function useRepositorySearchTarget(): RepositorySearchTarget | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): RepositorySearchTarget | null {
  return target;
}

function emit(): void {
  for (const listener of listeners) listener();
}
