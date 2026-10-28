import type { ObjectiveActivityVisual } from "../../../execution/client/objective-activity.js";
import { useSyncExternalStore } from "react";

import type { ObjectiveRuntimeState } from "../../../execution/shared/client-contract.js";

import { clearDeparture, clearIdleArrival, isIdleArrivalAcknowledgementSuspended, markDeparture, markIdleArrival } from "../../../execution/client/objective-marks.js";
import { resolveObjectiveActivity } from "../../../execution/client/objective-activity.js";
import { MACOS_TRAFFIC_LIGHTS } from "@fleet-console/protocol/desktop/chrome";
import { getDesktopZoomFactor, subscribeDesktopZoomFactor, getState, subscribe } from "../../../../core/client/src/integration/store.js";
import type { ObjectiveRecord } from "../../../../core/client/src/integration/types.js";

interface SideBarState {
  readonly width: number;
  readonly compactWidth: number;
  /**
   * 창이 좁아 사이드바가 사령관 중심의 좁은 열로 물러난 상태. 저장하지 않는 화면 상태다 —
   * 창을 넓히면 사람이 정한 폭으로 돌아온다. 사이드바는 접히지 않는다 — 늘 그 자리에 선다.
   */
  readonly compact: boolean;
  /** 대화 폭 요청을 제외한 창 자체의 compact 판정. 목록 위치의 순환을 끊는 기준이다. */
  readonly viewportCompact: boolean;
}

const STORAGE_KEY_WIDTH = "fleet-console.objectiveRecords.side-width";
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
let conversationCompact = false;

let sideBarState: SideBarState = {
  width: readInitialWidth(),
  compactWidth: readCompactWidth(),
  compact: readCompact(),
  viewportCompact: readCompact(),
};
if (typeof window !== "undefined") {
  subscribeDesktopZoomFactor(() => {
    const compactWidth = readCompactWidth();
    if (sideBarState.compactWidth === compactWidth) return;
    sideBarState = { ...sideBarState, compactWidth };
    notifyListeners();
  });
  window.addEventListener("resize", () => {
    const viewportCompact = readCompact();
    if (sideBarState.viewportCompact === viewportCompact) return;
    sideBarState = { ...sideBarState, viewportCompact, compact: viewportCompact || conversationCompact };
    notifyListeners();
  });
}
// 활동 전이 추적 — 직전 활동과 처음 관측한 라이브 Objective. 출발·도착 표식은 전이 순간에만 붙는다.
let previousActivityById = new Map<string, SideBarStatus>();
let baselinedLiveActivityIds = new Set<string>();

// Objective의 활동 상태 — 전이 추적이 이 값끼리 비교한다.
export type SideBarStatus = "awaiting" | "running" | "idle" | "ended";

export function useSideBarState(): SideBarState {
  return useSyncExternalStore(subscribeSideBarState, getSideBarState, getSideBarState);
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

/** 펼친 채팅 목록의 자리 요청. 사람이 정한 폭은 저장소·메모리 어느 쪽에서도 바꾸지 않는다. */
export function setSideBarConversationCompact(compact: boolean): void {
  conversationCompact = compact;
  const next = sideBarState.viewportCompact || compact;
  if (sideBarState.compact === next) return;
  sideBarState = { ...sideBarState, compact: next };
  notifyListeners();
}

/** 카드가 실제로 차지하는 폭 — 좁은 창에서는 아바타 열, 그 밖에는 사용자가 정한 폭. */
export function sideBarOccupiedWidth(state: SideBarState): number {
  if (state.compact) return state.compactWidth;
  return state.width;
}

export function trackObjectiveActivityTransitions(input: {
  readonly objectiveRecords: readonly ObjectiveRecord[];
  readonly objectiveRecordRuntime: Readonly<Record<string, ObjectiveRuntimeState>>;
  readonly activeObjectiveId: string | null;
  readonly activeObjectiveAcknowledged: boolean;
}): readonly string[] {
  const nextStatuses = new Map<string, SideBarStatus>(
    input.objectiveRecords.map((objectiveRecord) => [
      objectiveRecord.id,
      resolveObjectiveActivity(objectiveRecord, input.objectiveRecordRuntime),
    ]),
  );
  const firstLiveIds = input.objectiveRecords
    .filter((objectiveRecord) => {
      if (input.objectiveRecordRuntime[objectiveRecord.id] === undefined || baselinedLiveActivityIds.has(objectiveRecord.id)) {
        return false;
      }
      baselinedLiveActivityIds.add(objectiveRecord.id);
      return true;
    })
    .map((objectiveRecord) => objectiveRecord.id);
  const movedIds = input.objectiveRecords
    .filter((objectiveRecord) => {
      const previous = previousActivityById.get(objectiveRecord.id);
      return previous !== undefined
        && previous !== nextStatuses.get(objectiveRecord.id)
        && !firstLiveIds.includes(objectiveRecord.id);
    })
    .map((objectiveRecord) => objectiveRecord.id);

  for (const objectiveRecord of input.objectiveRecords) {
    if (!movedIds.includes(objectiveRecord.id)) continue;
    // 확인 처리가 정지된 동안에는 어떤 활성도 "이미 확인됨"으로 치지 않는다. 정지는 그 사이 완료를
    // 도착 마크로 남기지 않으며, 마크는 전이 순간에만 붙는다. 판정만 정지에 맞추고
    // activeObjectiveAcknowledged 자체는 두어야 한다 — 그 값을 내리면 종료 복구(setActiveObjective)가
    // 전부터 있던 도착 마크까지 확인 처리해 지운다.
    const watched = objectiveRecord.id === input.activeObjectiveId && input.activeObjectiveAcknowledged === true;
    const focusedAndAcknowledged = watched && !isIdleArrivalAcknowledgementSuspended();
    if (nextStatuses.get(objectiveRecord.id) === "running") {
      if (!focusedAndAcknowledged) markDeparture(objectiveRecord.id);
    } else {
      clearDeparture(objectiveRecord.id);
    }
    if (nextStatuses.get(objectiveRecord.id) === "idle") {
      if (!focusedAndAcknowledged) markIdleArrival(objectiveRecord.id);
    } else {
      clearIdleArrival(objectiveRecord.id);
    }
  }
  previousActivityById = nextStatuses;
  return movedIds;
}

export function subscribeObjectiveActivityTracking(): () => void {
  return subscribe(() => {
    const state = getState();
    trackObjectiveActivityTransitions({
      objectiveRecords: state.objectiveRecords,
      objectiveRecordRuntime: state.objectiveRecordRuntime,
      activeObjectiveId: state.activeObjectiveId,
      activeObjectiveAcknowledged: state.activeObjectiveAcknowledged,
    });
  });
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

function notifyListeners(): void {
  for (const listener of sideBarListeners) listener();
}

export function getSideBarState(): SideBarState {
  // 모듈을 읽은 뒤 Desktop 마커가 붙을 수 있다. 첫 소비도 실제 셸 폭을 읽되 같은 폭이면 스냅숏 참조를 유지한다.
  const compactWidth = readCompactWidth();
  if (sideBarState.compactWidth !== compactWidth) sideBarState = { ...sideBarState, compactWidth };
  return sideBarState;
}

export function subscribeSideBarState(listener: () => void): () => void {
  sideBarListeners.add(listener);
  return () => sideBarListeners.delete(listener);
}
