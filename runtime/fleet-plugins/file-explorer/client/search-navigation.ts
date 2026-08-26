import { useSyncExternalStore } from "react";

export interface FileSearchTarget {
  readonly theaterId: string;
  readonly relativePath: string;
  readonly requestId: number;
  /** 내용 검색에서 선택한 1-based 줄. 뷰어가 열리면 해당 줄로 이동한다. */
  readonly lineNumber?: number;
  readonly ranges?: readonly { readonly start: number; readonly end: number }[];
}

type Listener = () => void;

const listeners = new Set<Listener>();
let requestId = 0;
let target: FileSearchTarget | null = null;

export function activateFileSearchTarget(
  theaterId: string,
  relativePath: string,
  location?: Pick<FileSearchTarget, "lineNumber" | "ranges">,
): void {
  target = { theaterId, relativePath, requestId: ++requestId, ...location };
  emit();
}

/**
 * 검색 타깃과 같은 단조 증가 카운터에서 reveal 전용 requestId를 발급한다.
 * 트리는 requestId의 전진만 보고 소비 여부를 판정하므로, 별도 카운터를 두면 충돌한다.
 */
export function mintRevealRequestId(): number {
  return ++requestId;
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
