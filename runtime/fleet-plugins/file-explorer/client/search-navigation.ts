import { useSyncExternalStore } from "react";

export interface FileSearchTarget {
  readonly theaterId: string;
  readonly relativePath: string;
  readonly requestId: number;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let requestId = 0;
let target: FileSearchTarget | null = null;

export function activateFileSearchTarget(theaterId: string, relativePath: string): void {
  target = { theaterId, relativePath, requestId: ++requestId };
  emit();
}

export function consumeFileSearchTarget(expected: FileSearchTarget): void {
  if (target?.requestId !== expected.requestId) return;
  target = null;
  emit();
}

export function useFileSearchTarget(): FileSearchTarget | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): FileSearchTarget | null {
  return target;
}

function emit(): void {
  for (const listener of listeners) listener();
}
