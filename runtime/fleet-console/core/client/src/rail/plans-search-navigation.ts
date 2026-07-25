import { useSyncExternalStore } from "react";

export interface PlansSearchTarget {
  readonly theaterId: string;
  readonly name: string;
  readonly requestId: number;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let requestId = 0;
let target: PlansSearchTarget | null = null;

export function activatePlansSearchTarget(theaterId: string, name: string): void {
  target = { theaterId, name, requestId: ++requestId };
  emit();
}

export function consumePlansSearchTarget(expected: PlansSearchTarget): void {
  if (target?.requestId !== expected.requestId) return;
  target = null;
  emit();
}

export function getPlansSearchTargetForTest(): PlansSearchTarget | null {
  return target;
}

export function usePlansSearchTarget(): PlansSearchTarget | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): PlansSearchTarget | null {
  return target;
}

function emit(): void {
  for (const listener of listeners) listener();
}
