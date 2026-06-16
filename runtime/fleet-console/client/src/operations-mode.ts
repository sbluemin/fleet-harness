import { useSyncExternalStore } from "react";

export type OperationsMode = "canvas" | "classic";

type Listener = () => void;

const OPERATIONS_MODE_STORAGE_KEY = "fleet-console.operations.mode";
const DEFAULT_OPERATIONS_MODE: OperationsMode = "canvas";

const listeners = new Set<Listener>();
let mode: OperationsMode = readStoredOperationsMode();

export function useOperationsMode(): OperationsMode {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function setOperationsMode(nextMode: OperationsMode): void {
  if (mode === nextMode) return;
  mode = nextMode;
  writeStoredOperationsMode(nextMode);
  emit();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): OperationsMode {
  return mode;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function readStoredOperationsMode(): OperationsMode {
  if (typeof window === "undefined") return DEFAULT_OPERATIONS_MODE;
  try {
    const stored = window.localStorage.getItem(OPERATIONS_MODE_STORAGE_KEY);
    return stored === "classic" || stored === "canvas" ? stored : DEFAULT_OPERATIONS_MODE;
  } catch {
    return DEFAULT_OPERATIONS_MODE;
  }
}

function writeStoredOperationsMode(nextMode: OperationsMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(OPERATIONS_MODE_STORAGE_KEY, nextMode);
  } catch {
    // 모드 선호 저장 실패는 화면 전환 자체를 막지 않는다.
  }
}
