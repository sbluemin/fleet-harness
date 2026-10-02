import { useSyncExternalStore } from "react";

import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "../../../execution/client/operation-marks.js";
import { useCanvasState } from "../canvas/canvas-store.js";
import { getTriageSnapshot, resolveTriageCounts, resolveTriageQueue, subscribeTriage, useTriageStage } from "../canvas/triage-store.js";

/** 섬과 사이드바는 War Room 무대와 같은 전 Theater 큐를 읽는다. */
export function useAttentionQueue() {
  const state = useConsoleState();
  useSyncExternalStore(subscribeTriage, getTriageSnapshot, getTriageSnapshot);
  const arrivals = useSyncExternalStore(subscribeIdleArrival, getIdleArrivalIds, getIdleArrivalIds);
  useCanvasState();
  const stagedId = useTriageStage();
  const queue = resolveTriageQueue(state.operations, state.operationRuntime);
  const next = queue.find(({ operation }) => operation.id !== stagedId)?.operation ?? null;
  return { state, queue, next, stagedId, arrivals, counts: resolveTriageCounts(state.operations, state.operationRuntime) };
}
