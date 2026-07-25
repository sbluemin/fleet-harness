import { useSyncExternalStore } from "react";

import type { OperationActivity } from "@fleet-console/sdk/plugin";

import { resolveOperationActivity } from "../operation-activity.js";
import { registerSideBarStatusAxisActivationGuard, setSideBarStatusAxis } from "../sidebar/operations-side-bar-store.js";
import type { OperationNode } from "../types.js";
import {
  clearFormationView,
  forceDropCompanionOperationId,
  getLoadedTheaterId,
  getTheaterCanvasSnapshot,
  getTheaterFocusLayerSnapshot,
  registerBeforeFormationViewActivation,
  setTheaterFocusLayerSnapshot,
  type FocusLayerState,
} from "./canvas-store.js";

type Listener = () => void;

export interface TriageQueueEntry {
  readonly operation: OperationNode;
  readonly activity: OperationActivity;
  readonly picked: boolean;
}

export interface TriageStageIdentity {
  readonly theaterId: string;
  readonly operationId: string | null;
}

const RETURN_WINDOW_MS = 10_000;
const CLEAR_DELAY_MS = 600;

const triageByTheater = new Map<string, true>();
const pickedByTheater = new Map<string, string>();
const clearedByTheater = new Map<string, number>();
const enteredAtByTheater = new Map<string, number>();
const lastClearedAt = new Map<string, number>();
const deferredAt = new Map<string, number>();
const dismissed = new Set<string>();
const seenAt = new Map<string, number>();

const activityByOperation = new Map<string, OperationActivity>();
const liveActivityObserved = new Set<string>();
const operationTheater = new Map<string, string>();
const focusLayerBeforeTriage = new Map<string, FocusLayerState | null>();
const listeners = new Set<Listener>();
let revision = 0;

registerBeforeFormationViewActivation((theaterId) => setTriageActive(theaterId, false));
registerSideBarStatusAxisActivationGuard(() => !isTriageActive(getLoadedTheaterId()));

export function isTriageActive(theaterId: string | null): boolean {
  return theaterId !== null && triageByTheater.has(theaterId);
}

export function setTriageActive(theaterId: string, active: boolean): void {
  if (active) {
    clearFormationView(theaterId);
    setSideBarStatusAxis(false);
    if (!triageByTheater.has(theaterId)) {
      focusLayerBeforeTriage.set(theaterId, getTheaterFocusLayerSnapshot(theaterId));
      triageByTheater.set(theaterId, true);
      clearedByTheater.set(theaterId, 0);
      enteredAtByTheater.set(theaterId, Date.now());
    }
    setTheaterFocusLayerSnapshot(theaterId, null);
    emitTriage();
    return;
  }
  if (!triageByTheater.has(theaterId)) return;
  const previousFocusLayer = focusLayerBeforeTriage.get(theaterId) ?? null;
  const canvas = getTheaterCanvasSnapshot(theaterId);
  const restoredFocusLayer = previousFocusLayer
    && canvas.operations[previousFocusLayer.operationId]
    && !canvas.minimized.includes(previousFocusLayer.operationId)
    ? previousFocusLayer
    : null;
  if (getLoadedTheaterId() === theaterId && getTheaterFocusLayerSnapshot(theaterId)?.mode === "companion") {
    forceDropCompanionOperationId();
  }
  triageByTheater.delete(theaterId);
  pickedByTheater.delete(theaterId);
  clearedByTheater.delete(theaterId);
  enteredAtByTheater.delete(theaterId);
  focusLayerBeforeTriage.delete(theaterId);
  clearTheaterTransientOperations(theaterId);
  setTheaterFocusLayerSnapshot(theaterId, restoredFocusLayer);
  emitTriage();
}

export function useTriageActive(theaterId: string | null): boolean {
  return useSyncExternalStore(
    subscribeTriage,
    () => isTriageActive(theaterId),
    () => isTriageActive(theaterId),
  );
}

export function pickTriageOperation(theaterId: string, operationId: string): void {
  operationTheater.set(operationId, theaterId);
  dismissed.delete(operationId);
  const wasDeferred = deferredAt.delete(operationId);
  if (pickedByTheater.get(theaterId) === operationId) {
    if (wasDeferred) emitTriage();
    return;
  }
  pickedByTheater.set(theaterId, operationId);
  emitTriage();
}

export function getTriagePick(theaterId: string): string | null {
  return pickedByTheater.get(theaterId) ?? null;
}

export function markTriageCleared(theaterId: string, operationId: string): void {
  operationTheater.set(operationId, theaterId);
  deferredAt.delete(operationId);
  lastClearedAt.set(operationId, Date.now());
  clearedByTheater.set(theaterId, (clearedByTheater.get(theaterId) ?? 0) + 1);
  if (pickedByTheater.get(theaterId) === operationId) pickedByTheater.delete(theaterId);
  emitTriage();
}

export function getTriageCleared(theaterId: string): number {
  return clearedByTheater.get(theaterId) ?? 0;
}

export function dismissTriageOperation(theaterId: string, operationId: string): void {
  operationTheater.set(operationId, theaterId);
  deferredAt.delete(operationId);
  dismissed.add(operationId);
  if (pickedByTheater.get(theaterId) === operationId) pickedByTheater.delete(theaterId);
  emitTriage();
}

export function resetTriageTheater(theaterId: string): void {
  const wasActive = triageByTheater.has(theaterId);
  if (wasActive) setTriageActive(theaterId, false);
  else {
    pickedByTheater.delete(theaterId);
    clearedByTheater.delete(theaterId);
    enteredAtByTheater.delete(theaterId);
    focusLayerBeforeTriage.delete(theaterId);
    clearTheaterTransientOperations(theaterId);
    emitTriage();
  }
}

export function forgetTriageOperation(operationId: string): void {
  const theaterId = operationTheater.get(operationId);
  dismissed.delete(operationId);
  lastClearedAt.delete(operationId);
  deferredAt.delete(operationId);
  seenAt.delete(operationId);
  activityByOperation.delete(operationId);
  liveActivityObserved.delete(operationId);
  operationTheater.delete(operationId);
  if (theaterId && pickedByTheater.get(theaterId) === operationId) {
    pickedByTheater.delete(theaterId);
  }
  for (const [snapshotTheaterId, focusLayer] of focusLayerBeforeTriage) {
    if (focusLayer?.operationId === operationId) focusLayerBeforeTriage.set(snapshotTheaterId, null);
  }
  emitTriage();
}

export function subscribeTriage(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getTriageSnapshot(): number {
  return revision;
}

export function getTriageEnteredAt(theaterId: string): number | null {
  return enteredAtByTheater.get(theaterId) ?? null;
}

export function deferTriageOperation(theaterId: string, operationId: string, now = Date.now()): void {
  operationTheater.set(operationId, theaterId);
  let latestDeferredAt = 0;
  for (const [candidateId, timestamp] of deferredAt) {
    if (operationTheater.get(candidateId) === theaterId) latestDeferredAt = Math.max(latestDeferredAt, timestamp);
  }
  deferredAt.set(operationId, Math.max(now, latestDeferredAt + 1));
  emitTriage();
}

export function isTriageOperationDismissed(operationId: string): boolean {
  return dismissed.has(operationId);
}

export function isTriageOperationDeferred(operationId: string): boolean {
  return deferredAt.has(operationId);
}

export function focusedTriageOperationId(activeElement: Element | null): string | null {
  const frame = activeElement?.closest<HTMLElement>(".canvas-operation[data-operation-id]") ?? null;
  return frame?.dataset.operationId ?? null;
}

export function recordTriageActivity(
  theaterId: string,
  operations: readonly OperationNode[],
  operationStatus: Readonly<Record<string, OperationActivity>>,
  now = Date.now(),
): void {
  let changed = false;
  for (const operation of operations) {
    if (operation.theaterId !== theaterId) continue;
    if (operationTheater.get(operation.id) !== theaterId) {
      operationTheater.set(operation.id, theaterId);
      changed = true;
    }
    const activity = resolveOperationActivity(operation, operationStatus);
    if ((activity === "running" || activity === "dormant") && deferredAt.delete(operation.id)) {
      changed = true;
    }
    const liveActivity = Object.prototype.hasOwnProperty.call(operationStatus, operation.id);
    const liveActivityChanged = liveActivityObserved.has(operation.id) !== liveActivity;
    if (liveActivity) liveActivityObserved.add(operation.id);
    else liveActivityObserved.delete(operation.id);
    if (activityByOperation.get(operation.id) === activity && !liveActivityChanged) continue;
    activityByOperation.set(operation.id, activity);
    seenAt.set(operation.id, now);
    changed = true;
  }
  if (changed) emitTriage();
}

export function isTriageClearedTransition(
  previous: OperationActivity | null,
  current: OperationActivity,
): boolean {
  return (previous === "awaiting" || previous === "idle")
    && (current === "running" || current === "dormant");
}

export function isTriageWaitingOperation(
  operation: OperationNode,
  operationStatus: Readonly<Record<string, OperationActivity>>,
): boolean {
  const activity = resolveOperationActivity(operation, operationStatus);
  return activity === "awaiting"
    || (activity === "idle" && Object.prototype.hasOwnProperty.call(operationStatus, operation.id));
}

export function scheduleTriageClear(
  theaterId: string,
  operationId: string,
  shouldClear: () => boolean,
  onSettled: () => void = () => {},
): () => void {
  const timer = globalThis.setTimeout(() => {
    const clear = shouldClear();
    onSettled();
    if (clear) markTriageCleared(theaterId, operationId);
  }, CLEAR_DELAY_MS);
  return () => globalThis.clearTimeout(timer);
}

export function reconcileTriageStageCompanion(
  previous: TriageStageIdentity | null,
  next: TriageStageIdentity,
): TriageStageIdentity {
  if (previous?.theaterId !== next.theaterId || previous.operationId !== next.operationId) {
    forceDropCompanionOperationId();
  }
  return next;
}

export function resolveTriageQueue(
  theaterId: string,
  operations: readonly OperationNode[],
  operationStatus: Readonly<Record<string, OperationActivity>>,
  now = Date.now(),
): readonly TriageQueueEntry[] {
  const pickedId = pickedByTheater.get(theaterId) ?? null;
  const candidates: Array<TriageQueueEntry & {
    readonly deferredAt: number | null;
    readonly seenAt: number;
    readonly priority: number;
  }> = [];

  for (const operation of operations) {
    if (operation.theaterId !== theaterId) continue;
    const activity = resolveOperationActivity(operation, operationStatus);
    const picked = operation.id === pickedId;
    if (!picked && dismissed.has(operation.id)) continue;
    if (!picked && !isTriageWaitingOperation(operation, operationStatus)) continue;
    const lastCleared = lastClearedAt.get(operation.id) ?? Number.NEGATIVE_INFINITY;
    const delta = now - lastCleared;
    const returned = activity === "awaiting" && delta >= 0 && delta <= RETURN_WINDOW_MS;
    candidates.push({
      operation,
      activity,
      picked,
      deferredAt: deferredAt.get(operation.id) ?? null,
      seenAt: seenAt.get(operation.id) ?? now,
      priority: picked ? 0 : returned ? 1 : activity === "awaiting" ? 2 : 3,
    });
  }

  const tiebreak = (left: typeof candidates[number], right: typeof candidates[number]) =>
    left.seenAt - right.seenAt
    || left.operation.ts.createdAt - right.operation.ts.createdAt
    || left.operation.id.localeCompare(right.operation.id);

  candidates.sort((left, right) => {
    const leftDeferred = left.deferredAt;
    const rightDeferred = right.deferredAt;
    if ((leftDeferred !== null) !== (rightDeferred !== null)) {
      return Number(leftDeferred !== null) - Number(rightDeferred !== null);
    }
    // 미룬 것들끼리는 "미룬 순서"가 상태 우선순위를 이긴다. 그렇지 않으면 대기 전체가 한 번씩
    // 미뤄진 뒤 awaiting 항목이 매번 맨 앞으로 되돌아와 라운드로빈이 한 바퀴에서 멈춘다.
    if (leftDeferred !== null && rightDeferred !== null) {
      return leftDeferred - rightDeferred || left.priority - right.priority || tiebreak(left, right);
    }
    return left.priority - right.priority || tiebreak(left, right);
  });
  return candidates.map(({ operation, activity, picked }) => ({ operation, activity, picked }));
}

function clearTheaterTransientOperations(theaterId: string): void {
  for (const [operationId, ownerTheaterId] of operationTheater) {
    if (ownerTheaterId !== theaterId) continue;
    dismissed.delete(operationId);
    lastClearedAt.delete(operationId);
    deferredAt.delete(operationId);
    seenAt.delete(operationId);
    activityByOperation.delete(operationId);
    liveActivityObserved.delete(operationId);
    operationTheater.delete(operationId);
  }
}

function emitTriage(): void {
  revision += 1;
  for (const listener of listeners) listener();
}
