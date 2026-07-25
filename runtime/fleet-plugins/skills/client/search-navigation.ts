import { useSyncExternalStore } from "react";

import type { Scope } from "../server/types.js";

export interface SkillSearchTarget {
  readonly theaterId: string;
  readonly name: string;
  readonly scope: Scope;
  readonly requestId: number;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let requestId = 0;
let target: SkillSearchTarget | null = null;

export function activateSkillSearchTarget(theaterId: string, name: string, scope: Scope): void {
  target = { theaterId, name, scope, requestId: ++requestId };
  emit();
}

export function consumeSkillSearchTarget(expected: SkillSearchTarget): void {
  if (target?.requestId !== expected.requestId) return;
  target = null;
  emit();
}

export function useSkillSearchTarget(): SkillSearchTarget | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): SkillSearchTarget | null {
  return target;
}

function emit(): void {
  for (const listener of listeners) listener();
}
