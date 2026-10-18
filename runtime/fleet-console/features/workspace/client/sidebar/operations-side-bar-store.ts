import type { OperationActivityVisual } from "../../../execution/client/operation-activity.js";
import { useCallback, useSyncExternalStore } from "react";

import type { OperationRuntimeState } from "@fleet-console/sdk/plugin";

import { clearDeparture, clearIdleArrival, isIdleArrivalAcknowledgementSuspended, markDeparture, markIdleArrival, resetDepartureForTests, resetIdleArrivalForTests } from "../../../execution/client/operation-marks.js";
import { resolveOperationActivity } from "../../../execution/client/operation-activity.js";
import { MACOS_TRAFFIC_LIGHTS } from "@fleet-console/protocol/desktop/chrome";
import { getDesktopZoomFactor, subscribeDesktopZoomFactor, getState, subscribe } from "../../../../core/client/src/integration/store.js";
import type { OperationNode } from "../../../../core/client/src/integration/types.js";

interface SideBarState {
  readonly width: number;
  readonly compactWidth: number;
  /**
   * 창이 좁아 사이드바가 사령관 중심의 좁은 열로 물러난 상태. 저장하지 않는 화면 상태다 —
   * 창을 넓히면 사람이 정한 폭으로 돌아온다. 사이드바는 접히지 않는다 — 늘 그 자리에 선다.
   */
  readonly compact: boolean;
}

const STORAGE_KEY_WIDTH = "fleet-console.operations.side-width";
const STORAGE_KEY_THEATER_COLLAPSED = "fleet-console.operations.theater-collapsed";
export const MIN_EXPANDED_PX = 280;
/** 브라우저·비-macOS의 좁은 사령관 열 폭. macOS Desktop은 네이티브 신호등 양옆 여백을 맞춘다. */
const COMPACT_SIDE_BAR_PX = 72;

function readCompactWidth(): number {
  const root = typeof document === "undefined" ? null : document.documentElement;
  if (root?.dataset.desktopShell !== "true" || root.dataset.desktopPlatform !== "darwin") return COMPACT_SIDE_BAR_PX;
  const lights = MACOS_TRAFFIC_LIGHTS;
  return (lights.left + lights.span + lights.right) / getDesktopZoomFactor();
}
/** 이 폭 이하의 창에서 사이드바가 좁은 열로 물러난다 — 대화(360)와 도구 한 열(300)을 남기려는 무렵이다. */
const COMPACT_VIEWPORT_MAX_PX = 800;

function readCompact(): boolean {
  return typeof window !== "undefined" && window.innerWidth <= COMPACT_VIEWPORT_MAX_PX;
}
const DEFAULT_WIDTH = MIN_EXPANDED_PX;

const sideBarListeners = new Set<() => void>();
const collapsedTheaterListeners = new Set<() => void>();
const statusSectionCollapseListeners = new Set<() => void>();

let sideBarState: SideBarState = {
  width: readInitialWidth(),
  compactWidth: readCompactWidth(),
  compact: readCompact(),
};
if (typeof window !== "undefined") {
  subscribeDesktopZoomFactor(() => {
    const compactWidth = readCompactWidth();
    if (sideBarState.compactWidth === compactWidth) return;
    sideBarState = { ...sideBarState, compactWidth };
    notifyListeners();
  });
  window.addEventListener("resize", () => {
    const compact = readCompact();
    if (sideBarState.compact === compact) return;
    sideBarState = { ...sideBarState, compact };
    notifyListeners();
  });
}
let collapsedTheaterIds = readInitialCollapsedTheaters();
// STATUS 섹션 안쪽 접힘은 비영속 상태다. 빈 섹션의 기본 접힘과 사용자가 명시한
// 접기/펼치기를 구분하려고 두 집합을 유지하며 localStorage에는 기록하지 않는다.
let userCollapsedStatusSections = new Set<string>();
let userExpandedStatusSections = new Set<string>();
let statusTransitionCounter = 0;
let statusTransitionTicks = new Map<string, number>();
let previousActivityById = new Map<string, SideBarStatus>();
let baselinedLiveActivityIds = new Set<string>();
let pendingStatusLandingIds = new Set<string>();

// Operation의 활동 상태 — buildStatusSectionOrder의 상태 축이 이 값을 순회한다.
export type SideBarStatus = "awaiting" | "running" | "idle" | "ended";

export function useSideBarState(): SideBarState {
  return useSyncExternalStore(subscribeSideBarState, getSideBarState, getSideBarState);
}

export function useCollapsedTheaters(): readonly string[] {
  return useSyncExternalStore(subscribeCollapsedTheaters, getCollapsedTheatersSnapshot, getCollapsedTheatersSnapshot);
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

/** 카드가 실제로 차지하는 폭 — 좁은 창에서는 아바타 열, 그 밖에는 사용자가 정한 폭. */
export function sideBarOccupiedWidth(state: SideBarState): number {
  if (state.compact) return state.compactWidth;
  return state.width;
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

// 그룹별 「시작 전 N」 접기의 펼침 — 비영속 표시 상태다. 새 페이지 로드마다 모두 접힌 채 시작하고,
// Theater 를 옮겨 다녀도 이 탭 안에서는 그룹마다 남는다. 키는 Theater 와 그룹(미분류는 빈 문자열).
const freshFoldListeners = new Set<() => void>();
let expandedFreshFolds: ReadonlySet<string> = new Set();

export const freshFoldKey = (theaterId: string, groupId: string | null): string => `${theaterId}\0${groupId ?? ""}`;

export function useSideBarFreshFolds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeFreshFolds, getFreshFolds, getFreshFolds);
}

function getFreshFolds(): ReadonlySet<string> {
  return expandedFreshFolds;
}

function subscribeFreshFolds(listener: () => void): () => void {
  freshFoldListeners.add(listener);
  return () => freshFoldListeners.delete(listener);
}

export function setSideBarFreshFoldExpanded(theaterId: string, groupId: string | null, expanded: boolean): void {
  const key = freshFoldKey(theaterId, groupId);
  if (expandedFreshFolds.has(key) === expanded) return;
  const next = new Set(expandedFreshFolds);
  if (expanded) next.add(key);
  else next.delete(key);
  expandedFreshFolds = next;
  for (const listener of freshFoldListeners) listener();
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
    // 확인 처리가 정지된 동안에는 어떤 활성도 "이미 확인됨"으로 치지 않는다. 정지는 그 사이 완료를
    // 도착 마크로 남기지 않으며, 마크는 전이 순간에만 붙는다. 판정만 정지에 맞추고
    // activeOperationAcknowledged 자체는 두어야 한다 — 그 값을 내리면 종료 복구(setActiveOperation)가
    // 전부터 있던 도착 마크까지 확인 처리해 지운다.
    const focusedAndAcknowledged = operation.id === input.activeOperationId
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
