import { useSyncExternalStore } from "react";

import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "../../../execution/client/operation-marks.js";
import { getTheaterMinimizedIds, useCanvasState } from "../canvas/canvas-store.js";
import { getTriageSnapshot, resolveTriageCounts, resolveTriageQueue, subscribeTriage, useTriageStage } from "../canvas/triage-store.js";

/** 수동 확인 목록은 최소화 대기도 싣는다. War Room 자동 올리기의 기본 큐는 최소화를 제외한다. */
export function useAttentionQueue() {
  const state = useConsoleState();
  useSyncExternalStore(subscribeTriage, getTriageSnapshot, getTriageSnapshot);
  const arrivals = useSyncExternalStore(subscribeIdleArrival, getIdleArrivalIds, getIdleArrivalIds);
  useCanvasState();
  const stagedId = useTriageStage();
  const queue = resolveTriageQueue(state.operations, state.operationRuntime, Date.now(), true);
  const next = queue.find(({ operation }) => operation.id !== stagedId)?.operation ?? null;
  const minimizedIds = new Set(getTheaterMinimizedIds(state.theaters.map((theater) => theater.id)));
  return { state, queue, next, stagedId, arrivals, minimizedIds, counts: resolveTriageCounts(state.operations, state.operationRuntime) };
}
