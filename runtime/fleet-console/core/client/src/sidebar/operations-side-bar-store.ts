import type { OperationActivityVisual } from "../operation-activity.js";
import { useCallback, useSyncExternalStore } from "react";

import type { OperationRuntimeState } from "@fleet-console/sdk/plugin";

import { clearDeparture, clearIdleArrival, isIdleArrivalAcknowledgementSuspended, markDeparture, markIdleArrival, resetDepartureForTests, resetIdleArrivalForTests } from "../operation-marks.js";
import { resolveOperationActivity } from "../operation-activity.js";
import { getState, subscribe } from "../store.js";
import type { OperationNode } from "../types.js";

interface SideBarState {
  readonly width: number;
  readonly collapsed: boolean;
  /** 접힌 카드를 엣지 독 호버가 오버레이로 되부른 상태 — 세션 한정이며 아레나 인셋에 불참한다. */
  readonly peeking: boolean;
}

const STORAGE_KEY_WIDTH = "fleet-console.operations.side-width";
const STORAGE_KEY_COLLAPSED = "fleet-console.operations.side-collapsed";
const STORAGE_KEY_THEATER_COLLAPSED = "fleet-console.operations.theater-collapsed";
export const MIN_EXPANDED_PX = 280;
const DEFAULT_WIDTH = MIN_EXPANDED_PX;

const sideBarListeners = new Set<() => void>();
const collapsedTheaterListeners = new Set<() => void>();
const statusAxisListeners = new Set<() => void>();
const statusSectionCollapseListeners = new Set<() => void>();

let sideBarState: SideBarState = {
  width: readInitialWidth(),
  collapsed: readInitialCollapsed(),
  peeking: false,
};
let collapsedTheaterIds = readInitialCollapsedTheaters();
// STATUS 축은 의도적으로 세션 메모리에만 둔다. localStorage나 durable canvas state에
// 합류시키지 않아 새 페이지 로드마다 GROUP 축(false)에서 시작한다.
let statusAxis = false;
// STATUS 섹션 접힘도 같은 비영속 축이다. 빈 섹션의 기본 접힘과 사용자가 명시한
// 접기/펼치기를 구분하려고 두 집합을 유지하며 localStorage에는 기록하지 않는다.
let userCollapsedStatusSections = new Set<string>();
let userExpandedStatusSections = new Set<string>();
let statusTransitionCounter = 0;
let statusTransitionTicks = new Map<string, number>();
let previousActivityById = new Map<string, SideBarStatus>();
let baselinedLiveActivityIds = new Set<string>();
let pendingStatusLandingIds = new Set<string>();

// 앞의 다섯은 Operation의 활동 상태다. "minimized"는 활동이 아니라 사용자가 고른 표시 상태이며,
// 그래서 buildStatusSectionOrder의 상태 축에는 들어가지 않는다 — 활동 축을 순회하는 곳은 이 값을
// 만들지 않고, War Room의 최소화 선반만 같은 섹션 문법(접힘 키·카운트·빈 힌트)을 빌려 쓴다.
// background 활동은 실행 중 칸에 합류한다. 칸 키는 running이고, 행 마크는 그대로 background다.
export type SideBarStatus = "awaiting" | "running" | "background" | "idle" | "ended" | "minimized";

export function useSideBarState(): SideBarState {
  return useSyncExternalStore(subscribeSideBarState, getSideBarState, getSideBarState);
}

export function useCollapsedTheaters(): readonly string[] {
  return useSyncExternalStore(subscribeCollapsedTheaters, getCollapsedTheatersSnapshot, getCollapsedTheatersSnapshot);
}

export function useSideBarStatusAxis(): boolean {
  return useSyncExternalStore(subscribeStatusAxis, getSideBarStatusAxis, getSideBarStatusAxis);
}

export function useSideBarStatusSectionCollapsed(
  theaterId: string,
  status: SideBarStatus,
  empty: boolean,
): boolean {
  const getSnapshot = useCallback(
    () => getSideBarStatusSectionCollapsed(theaterId, status, empty),
    [theaterId, status, empty],
  );
  return useSyncExternalStore(subscribeStatusSectionCollapse, getSnapshot, getSnapshot);
}

export function setSideBarWidth(width: number): void {
  const clamped = Math.max(MIN_EXPANDED_PX, Math.min(getMaxPx(), width));
  if (sideBarState.width === clamped) return;
  sideBarState = { ...sideBarState, width: clamped };
  try {
    if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY_WIDTH, String(clamped));
  } catch { /* ignore */ }
  notifyListeners();
}

export function setSideBarCollapsed(collapsed: boolean): void {
  if (sideBarState.collapsed === collapsed) return;
  // dock 상태 전환은 어느 방향이든 픽을 끝낸다 — 펼침(고정)은 픽의 승격이고, 새 접힘은 픽 없이 시작한다.
  sideBarState = { ...sideBarState, collapsed, peeking: false };
  try {
    if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY_COLLAPSED, collapsed ? "1" : "0");
  } catch { /* ignore */ }
  notifyListeners();
}

/** 엣지 독 호버가 접힌 사이드바를 오버레이로 되부른다 — 접혀 있지 않으면 픽이 설 자리가 없다. */
export function setSideBarPeeking(peeking: boolean): void {
  const next = peeking && sideBarState.collapsed;
  if (sideBarState.peeking === next) return;
  sideBarState = { ...sideBarState, peeking: next };
  notifyListeners();
}

export function setTheaterCollapsed(theaterId: string, collapsed: boolean): void {
  const current = new Set(collapsedTheaterIds);
  if (collapsed) current.add(theaterId);
  else current.delete(theaterId);
  const next = Array.from(current);
  if (next.join("\0") === collapsedTheaterIds.join("\0")) return;
  collapsedTheaterIds = next;
  try {
    if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY_THEATER_COLLAPSED, JSON.stringify(next));
  } catch { /* ignore */ }
  notifyCollapsedTheaterListeners();
}

export function setSideBarStatusAxis(active: boolean): void {
  if (statusAxis === active) return;
  statusAxis = active;
  for (const listener of statusAxisListeners) listener();
}

export function toggleSideBarStatusAxis(): void {
  setSideBarStatusAxis(!statusAxis);
}

export function getSideBarStatusAxis(): boolean {
  return statusAxis;
}

export function subscribeStatusAxis(listener: () => void): () => void {
  statusAxisListeners.add(listener);
  return () => statusAxisListeners.delete(listener);
}

export function getSideBarStatusSectionCollapsed(
  theaterId: string,
  status: SideBarStatus,
  empty: boolean,
): boolean {
  const key = statusSectionKey(theaterId, status);
  if (userCollapsedStatusSections.has(key)) return true;
  if (userExpandedStatusSections.has(key)) return false;
  return empty;
}

export function toggleSideBarStatusSectionCollapsed(
  theaterId: string,
  status: SideBarStatus,
  empty: boolean,
): void {
  const key = statusSectionKey(theaterId, status);
  if (getSideBarStatusSectionCollapsed(theaterId, status, empty)) {
    userCollapsedStatusSections = new Set(userCollapsedStatusSections);
    userCollapsedStatusSections.delete(key);
    userExpandedStatusSections = new Set(userExpandedStatusSections).add(key);
  } else {
    userExpandedStatusSections = new Set(userExpandedStatusSections);
    userExpandedStatusSections.delete(key);
    userCollapsedStatusSections = new Set(userCollapsedStatusSections).add(key);
  }
  for (const listener of statusSectionCollapseListeners) listener();
}

export function subscribeStatusSectionCollapse(listener: () => void): () => void {
  statusSectionCollapseListeners.add(listener);
  return () => statusSectionCollapseListeners.delete(listener);
}

export function recordStatusTransitions(ids: readonly string[]): void {
  for (const id of ids) statusTransitionTicks.set(id, ++statusTransitionCounter);
}

export function getStatusTransitionTick(id: string): number | undefined {
  return statusTransitionTicks.get(id);
}

export function trackOperationActivityTransitions(input: {
  readonly operations: readonly OperationNode[];
  readonly operationRuntime: Readonly<Record<string, OperationRuntimeState>>;
  readonly activeTheaterId: string | null;
  readonly activeOperationId: string | null;
  readonly activeOperationAcknowledged: boolean;
}): readonly string[] {
  const nextStatuses = new Map<string, SideBarStatus>(
    input.operations.map((operation) => [
      operation.id,
      resolveOperationActivity(operation, input.operationRuntime),
    ]),
  );
  const firstLiveIds = input.operations
    .filter((operation) => {
      if (input.operationRuntime[operation.id] === undefined || baselinedLiveActivityIds.has(operation.id)) {
        return false;
      }
      baselinedLiveActivityIds.add(operation.id);
      return true;
    })
    .map((operation) => operation.id);
  const movedIds = input.operations
    .filter((operation) => {
      const previous = previousActivityById.get(operation.id);
      return previous !== undefined
        && previous !== nextStatuses.get(operation.id)
        && !firstLiveIds.includes(operation.id);
    })
    .map((operation) => operation.id);

  recordStatusTransitions(movedIds);
  movedIds.forEach((id) => pendingStatusLandingIds.add(id));
  for (const operation of input.operations) {
    if (!movedIds.includes(operation.id)) continue;
    // 확인 처리가 정지된 동안(War Room)에는 어떤 활성도 "이미 확인됨"으로 치지 않는다. 그
    // 정지는 선별 중 활성화를 미인정으로 만들지만 진입 전에 인정된 활성은 건드리지 못하는데,
    // 그 패널이 선별 중 완료하면 여기서 도착 마크를 통째로 건너뛴다. 마크는 전이 순간에만 붙어
    // 되살아나지 않으므로, 그 Operation은 대기 큐로 돌아오지 못한 채 덱 카드에 남는다.
    // 판정만 정지에 맞추고 activeOperationAcknowledged 자체는 두어야 한다 — 그 값을 진입에서
    // 내리면 종료 복구(setActiveOperation)가 진입 전부터 있던 도착 마크까지 확인 처리해 지운다.
    const focusedAndAcknowledged = operation.id === input.activeOperationId
      && operation.theaterId === input.activeTheaterId
      && input.activeOperationAcknowledged === true
      && !isIdleArrivalAcknowledgementSuspended();
    if (nextStatuses.get(operation.id) === "running") {
      if (!focusedAndAcknowledged) markDeparture(operation.id);
    } else {
      clearDeparture(operation.id);
    }
    if (nextStatuses.get(operation.id) === "idle") {
      if (!focusedAndAcknowledged) markIdleArrival(operation.id);
    } else {
      clearIdleArrival(operation.id);
    }
  }
  previousActivityById = nextStatuses;
  return movedIds;
}

export function consumeStatusLandings(): readonly string[] {
  const landedIds = Array.from(pendingStatusLandingIds);
  pendingStatusLandingIds = new Set();
  return landedIds;
}

export function subscribeOperationActivityTracking(): () => void {
  return subscribe(() => {
    const state = getState();
    trackOperationActivityTransitions({
      operations: state.operations,
      operationRuntime: state.operationRuntime,
      activeTheaterId: state.activeTheaterId,
      activeOperationId: state.activeOperationId,
      activeOperationAcknowledged: state.activeOperationAcknowledged,
    });
  });
}

export function resetSideBarStatusSectionCollapseForTests(): void {
  userCollapsedStatusSections = new Set();
  userExpandedStatusSections = new Set();
}

export function resetSideBarStatusRecencyForTests(): void {
  statusTransitionCounter = 0;
  statusTransitionTicks = new Map();
  resetDepartureForTests();
  resetIdleArrivalForTests();
  previousActivityById = new Map();
  baselinedLiveActivityIds = new Set();
  pendingStatusLandingIds = new Set();
}

function statusSectionKey(theaterId: string, status: SideBarStatus): string {
  return `${theaterId}:${status}`;
}

function getMaxPx(): number {
  return typeof window !== "undefined" ? Math.max(MIN_EXPANDED_PX, window.innerWidth - 480) : 800;
}

function readInitialWidth(): number {
  try {
    if (typeof window === "undefined") return DEFAULT_WIDTH;
    const value = localStorage.getItem(STORAGE_KEY_WIDTH);
    if (value !== null) {
      const parsed = parseInt(value, 10);
      if (!Number.isNaN(parsed)) return Math.max(MIN_EXPANDED_PX, Math.min(getMaxPx(), parsed));
    }
  } catch { /* ignore */ }
  return DEFAULT_WIDTH;
}

function readInitialCollapsed(): boolean {
  try {
    return typeof window !== "undefined" && localStorage.getItem(STORAGE_KEY_COLLAPSED) === "1";
  } catch { return false; }
}

function readInitialCollapsedTheaters(): readonly string[] {
  try {
    if (typeof window === "undefined") return [];
    const raw = localStorage.getItem(STORAGE_KEY_THEATER_COLLAPSED);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch { return []; }
}

function notifyListeners(): void {
  for (const listener of sideBarListeners) listener();
}

export function getSideBarState(): SideBarState {
  return sideBarState;
}

export function subscribeSideBarState(listener: () => void): () => void {
  sideBarListeners.add(listener);
  return () => sideBarListeners.delete(listener);
}

function notifyCollapsedTheaterListeners(): void {
  for (const listener of collapsedTheaterListeners) listener();
}

function getCollapsedTheatersSnapshot(): readonly string[] {
  return collapsedTheaterIds;
}

function subscribeCollapsedTheaters(listener: () => void): () => void {
  collapsedTheaterListeners.add(listener);
  return () => collapsedTheaterListeners.delete(listener);
}

/* ── 좌측 사이드바 유리 손잡이 ───────────────────────────────────────
   부유 카드의 유리 재질을 사람이 직접 고른다: 알파(카드 배경 레이어 전체의 불투명도)와
   blur 반경 둘. 우측 사이드바 불투명도와 같은 realm(브라우저-로컬 localStorage)에 산다 —
   화면 재질 취향은 모니터·조명·기기마다 다르고, 서버 전역 설정으로 올리면 다른 화면의
   같은 계정까지 따라간다.

   값은 반드시 **문서 루트**에 실린다. blur 반경은 theme.css의 게이트 블록이 :root에서
   `--glass-on-backdrop-side-bar` 안으로 치환하는데, custom property의 var() 치환은 그 속성이
   선언된 요소에서 끝나므로, 사이드바 요소에 실으면 이미 폴백(24px)이 박힌 값만 상속되어
   손잡이가 닿지 않는다. 알파도 같은 자리에 실어 둘의 소유자를 하나로 유지한다. */
export const SIDE_BAR_GLASS_ALPHA_MIN = 40;
export const SIDE_BAR_GLASS_ALPHA_MAX = 100;
export const SIDE_BAR_GLASS_ALPHA_DEFAULT = 100;
export const SIDE_BAR_GLASS_BLUR_MIN = 0;
export const SIDE_BAR_GLASS_BLUR_MAX = 40;
export const SIDE_BAR_GLASS_BLUR_DEFAULT = 24;

export interface SideBarGlass {
  /** 카드 배경 레이어의 불투명도(%) — 100이 지금까지의 재질 그대로다. */
  readonly alpha: number;
  /** backdrop-filter blur 반경(px). 0은 흐리지 않음이며 채도 보정만 남는다. */
  readonly blur: number;
}

const STORAGE_KEY_GLASS_ALPHA = "fleet-console.operations.side-glass-alpha";
const STORAGE_KEY_GLASS_BLUR = "fleet-console.operations.side-glass-blur";
const sideBarGlassListeners = new Set<() => void>();

let sideBarGlass: SideBarGlass = {
  alpha: readStoredGlassValue(STORAGE_KEY_GLASS_ALPHA, SIDE_BAR_GLASS_ALPHA_DEFAULT, clampSideBarGlassAlpha),
  blur: readStoredGlassValue(STORAGE_KEY_GLASS_BLUR, SIDE_BAR_GLASS_BLUR_DEFAULT, clampSideBarGlassBlur),
};

export function useSideBarGlass(): SideBarGlass {
  return useSyncExternalStore(subscribeSideBarGlass, getSideBarGlass, getSideBarGlass);
}

export function getSideBarGlass(): SideBarGlass {
  return sideBarGlass;
}

export function subscribeSideBarGlass(listener: () => void): () => void {
  sideBarGlassListeners.add(listener);
  return () => sideBarGlassListeners.delete(listener);
}

export function setSideBarGlassAlpha(alpha: number): void {
  const clamped = clampSideBarGlassAlpha(alpha);
  if (sideBarGlass.alpha === clamped) return;
  sideBarGlass = { ...sideBarGlass, alpha: clamped };
  saveGlassValue(STORAGE_KEY_GLASS_ALPHA, clamped);
  applySideBarGlass(sideBarGlass);
  notifySideBarGlassListeners();
}

export function setSideBarGlassBlur(blur: number): void {
  const clamped = clampSideBarGlassBlur(blur);
  if (sideBarGlass.blur === clamped) return;
  sideBarGlass = { ...sideBarGlass, blur: clamped };
  saveGlassValue(STORAGE_KEY_GLASS_BLUR, clamped);
  applySideBarGlass(sideBarGlass);
  notifySideBarGlassListeners();
}

/** 부팅이 저장된 취향을 첫 페인트 앞에서 한 번 싣는다 — CSS 폴백이 곧 기본값이라 미호출도 안전하다. */
export function applyStoredSideBarGlass(): void {
  applySideBarGlass(sideBarGlass);
}

export function resetSideBarGlassForTests(): void {
  sideBarGlass = { alpha: SIDE_BAR_GLASS_ALPHA_DEFAULT, blur: SIDE_BAR_GLASS_BLUR_DEFAULT };
  try {
    if (typeof window !== "undefined") {
      localStorage.removeItem(STORAGE_KEY_GLASS_ALPHA);
      localStorage.removeItem(STORAGE_KEY_GLASS_BLUR);
    }
  } catch { /* ignore */ }
  applySideBarGlass(sideBarGlass);
  notifySideBarGlassListeners();
}

function applySideBarGlass(glass: SideBarGlass): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.setProperty("--side-bar-glass-alpha", String(glass.alpha / 100));
  root.style.setProperty("--side-bar-glass-blur", `${glass.blur}px`);
}

function readStoredGlassValue(key: string, fallback: number, clamp: (value: number) => number): number {
  try {
    if (typeof window === "undefined") return fallback;
    const raw = localStorage.getItem(key);
    if (raw === null || raw.trim() === "") return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clamp(parsed) : fallback;
  } catch { return fallback; }
}

function saveGlassValue(key: string, value: number): void {
  try {
    if (typeof window !== "undefined") localStorage.setItem(key, String(value));
  } catch { /* ignore */ }
}

function clampSideBarGlassAlpha(alpha: number): number {
  return Math.min(SIDE_BAR_GLASS_ALPHA_MAX, Math.max(SIDE_BAR_GLASS_ALPHA_MIN, Math.round(alpha)));
}

function clampSideBarGlassBlur(blur: number): number {
  return Math.min(SIDE_BAR_GLASS_BLUR_MAX, Math.max(SIDE_BAR_GLASS_BLUR_MIN, Math.round(blur)));
}

function notifySideBarGlassListeners(): void {
  for (const listener of sideBarGlassListeners) listener();
}
