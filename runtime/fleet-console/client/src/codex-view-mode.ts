import { useSyncExternalStore } from "react";

export type CodexViewMode = "route" | "side";

type Listener = () => void;

const VIEW_MODE_STORAGE_KEY = "fleet-console.codex.view-mode";
const SIDE_WIDTH_STORAGE_KEY = "fleet-console.codex.side-width";
const DEFAULT_VIEW_MODE: CodexViewMode = "route";
const DEFAULT_SIDE_WIDTH = 460;
// 폭 상한은 두지 않는다(대원수 지시). 핸들을 다시 잡을 수 있도록 최소 floor만 남긴다(뷰포트 상한은 CSS가 담당).
const MIN_SIDE_WIDTH = 120;

const listeners = new Set<Listener>();
let viewMode: CodexViewMode = readStoredViewMode();
let sideWidth: number = readStoredSideWidth();
// 이번 세션에서 사용자가 토글로 모드를 직접 골랐는지(in-memory, 새로고침 시 초기화). deep-link로 Full로
// 강등된 상태에서도 사용자가 모드를 고르면 오버레이가 뜨게 하되, 새로고침은 다시 Full로 떨어지게 한다.
let userChoseMode = false;

export function useCodexViewMode(): CodexViewMode {
  return useSyncExternalStore(subscribe, getViewModeSnapshot, getViewModeSnapshot);
}

export function getCodexViewMode(): CodexViewMode {
  return viewMode;
}

export function setCodexViewMode(nextMode: CodexViewMode): void {
  // 토글 클릭은 항상 "사용자가 직접 선택함"으로 표시한다 — 같은 값을 다시 눌러도(예: deep-link Full에서
  // 강조된 Side 재클릭) 오버레이가 뜨도록 emit한다.
  userChoseMode = true;
  if (viewMode === nextMode) {
    emit();
    return;
  }
  viewMode = nextMode;
  writeStored(VIEW_MODE_STORAGE_KEY, nextMode);
  emit();
}

export function hasUserChosenCodexMode(): boolean {
  return userChoseMode;
}

export function useCodexSideWidth(): number {
  return useSyncExternalStore(subscribe, getSideWidthSnapshot, getSideWidthSnapshot);
}

export function setCodexSideWidth(nextWidth: number): void {
  const clamped = clampSideWidth(nextWidth);
  if (sideWidth === clamped) return;
  sideWidth = clamped;
  writeStored(SIDE_WIDTH_STORAGE_KEY, String(clamped));
  emit();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getViewModeSnapshot(): CodexViewMode {
  return viewMode;
}

function getSideWidthSnapshot(): number {
  return sideWidth;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function clampSideWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SIDE_WIDTH;
  // 상한 없음 — 핸들 재파지를 위한 최소 floor만 적용(뷰포트 상한은 CSS max-width가 담당).
  return Math.max(MIN_SIDE_WIDTH, Math.round(value));
}

function readStoredViewMode(): CodexViewMode {
  if (typeof window === "undefined") return DEFAULT_VIEW_MODE;
  try {
    const stored = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return stored === "route" || stored === "side" ? stored : DEFAULT_VIEW_MODE;
  } catch {
    return DEFAULT_VIEW_MODE;
  }
}

function readStoredSideWidth(): number {
  if (typeof window === "undefined") return DEFAULT_SIDE_WIDTH;
  try {
    const raw = window.localStorage.getItem(SIDE_WIDTH_STORAGE_KEY);
    if (raw === null) return DEFAULT_SIDE_WIDTH;
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? DEFAULT_SIDE_WIDTH : clampSideWidth(parsed);
  } catch {
    return DEFAULT_SIDE_WIDTH;
  }
}

function writeStored(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 선호 저장 실패는 화면 전환 자체를 막지 않는다.
  }
}
