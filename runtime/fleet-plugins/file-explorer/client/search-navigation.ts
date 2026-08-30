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
const revealListeners = new Set<Listener>();
let requestId = 0;
let target: FileSearchTarget | null = null;
let reveal: FileSearchTarget | null = null;

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

// ═══ reveal 타깃 ═════════════════════════════════════════════════════════════
//
// "이 경로를 보여 달라"는 요청은 두 페인이 함께 본다 — 트리는 그 자리로 스크롤하고 펼치며,
// 문서 창은 내용 검색이 지목한 줄로 이동한다. 열이 갈라지기 전에는 패널 하나의 지역 상태로
// 충분했지만, 이제는 둘 다 같은 값을 봐야 하므로 스토어가 진다.

export function setFileRevealTarget(next: FileSearchTarget | null): void {
  if (reveal === next) return;
  reveal = next;
  for (const listener of revealListeners) listener();
}

export function useFileRevealTarget(): FileSearchTarget | null {
  return useSyncExternalStore(subscribeReveal, getRevealSnapshot, getRevealSnapshot);
}

export function getFileRevealTarget(): FileSearchTarget | null {
  return reveal;
}

function subscribeReveal(listener: Listener): () => void {
  revealListeners.add(listener);
  return () => { revealListeners.delete(listener); };
}

function getRevealSnapshot(): FileSearchTarget | null {
  return reveal;
}

/** 테스트 전용 — 모듈 스코프 상태를 초기화한다. */
export function __resetSearchNavigationForTests(): void {
  target = null;
  reveal = null;
  requestId = 0;
}
