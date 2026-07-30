import { useCallback, useSyncExternalStore } from "react";

import type { OperationActivity } from "@fleet-console/sdk/plugin";

import { clearDeparture, markDeparture, resetDepartureForTests } from "../operation-departure.js";
import { clearIdleArrival, markIdleArrival, resetIdleArrivalForTests } from "../operation-idle-arrival.js";
import { resolveOperationActivity } from "../operation-activity.js";
import { getState, subscribe } from "../store.js";
import type { OperationNode } from "../types.js";

interface SideBarState {
  readonly width: number;
  readonly collapsed: boolean;
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

export type SideBarStatus = "awaiting" | "running" | "idle" | "dormant";

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
  sideBarState = { ...sideBarState, collapsed };
  try {
    if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY_COLLAPSED, collapsed ? "1" : "0");
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
  readonly operationStatus: Readonly<Record<string, OperationActivity>>;
  readonly activeTheaterId: string | null;
  readonly activeOperationId: string | null;
  readonly activeOperationAcknowledged: boolean;
}): readonly string[] {
  const nextStatuses = new Map<string, SideBarStatus>(
    input.operations.map((operation) => [
      operation.id,
      resolveOperationActivity(operation, input.operationStatus),
    ]),
  );
  const firstLiveIds = input.operations
    .filter((operation) => {
      if (input.operationStatus[operation.id] === undefined || baselinedLiveActivityIds.has(operation.id)) {
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
    const focusedAndAcknowledged = operation.id === input.activeOperationId
      && operation.theaterId === input.activeTheaterId
      && input.activeOperationAcknowledged === true;
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
      operationStatus: state.operationStatus,
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
