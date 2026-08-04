import { useSyncExternalStore } from "react";

import type { OperationActivity } from "@fleet-console/sdk/plugin";

import { clearIdleArrival, getIdleArrivalIds, setIdleArrivalAcknowledgementSuspended } from "../operation-idle-arrival.js";
import { resolveOperationActivity } from "../operation-activity.js";
import { clearOperationStatusDetail, recordOperationActivityTransition } from "../operation-status-detail-store.js";
import { getSideBarStatusAxis, setSideBarStatusAxis } from "../sidebar/operations-side-bar-store.js";
import { getState, setActiveOperation } from "../store.js";
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
// 패널/사이드바 닫기의 1500ms 확인과 같은 두 번 눌러 확정 문법이라, 확인 시간이 달라지면 학습이 깨진다.
export const SET_ASIDE_ARM_DURATION_MS = 1500;

const triageByTheater = new Map<string, true>();
const pickedByTheater = new Map<string, string>();
const setAsideArmedByTheater = new Map<string, {
  readonly operationId: string;
  readonly timer: ReturnType<typeof globalThis.setTimeout>;
}>();
const clearedByTheater = new Map<string, number>();
const enteredAtByTheater = new Map<string, number>();
const lastClearedAt = new Map<string, number>();
const deferredAt = new Map<string, number>();
const dismissed = new Set<string>();
const seenAt = new Map<string, number>();

const TRIAGE_SPOTLIGHT_STORAGE_KEY = "fleet-console-triage-spotlight";
let triageSpotlightEnabled = readStoredTriageSpotlight();

function readStoredTriageSpotlight(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(TRIAGE_SPOTLIGHT_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function isTriageSpotlightEnabled(): boolean {
  return triageSpotlightEnabled;
}

export function setTriageSpotlightEnabled(enabled: boolean): void {
  if (triageSpotlightEnabled === enabled) return;
  triageSpotlightEnabled = enabled;
  if (typeof window !== "undefined") {
    try {
      if (enabled) {
        window.localStorage.removeItem(TRIAGE_SPOTLIGHT_STORAGE_KEY);
      } else {
        window.localStorage.setItem(TRIAGE_SPOTLIGHT_STORAGE_KEY, "0");
      }
    } catch {
      // 브라우저 저장소가 막힌 환경에서는 현재 세션 상태만 유지한다.
    }
  }
  emitTriage();
}

export function useTriageSpotlightEnabled(): boolean {
  return useSyncExternalStore(
    subscribeTriage,
    () => triageSpotlightEnabled,
    () => triageSpotlightEnabled,
  );
}

export function resetTriageSpotlightForTests(): void {
  triageSpotlightEnabled = true;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(TRIAGE_SPOTLIGHT_STORAGE_KEY);
    } catch {
      // 저장소가 막힌 환경에서는 현재 세션 상태만 되돌린다.
    }
  }
  emitTriage();
}

const activityByOperation = new Map<string, OperationActivity>();
const operationTheater = new Map<string, string>();
const focusLayerBeforeTriage = new Map<string, FocusLayerState | null>();
let statusAxisBeforeTriage = false;
const listeners = new Set<Listener>();
let revision = 0;

registerBeforeFormationViewActivation((theaterId) => setTriageActive(theaterId, false));
export function isTriageActive(theaterId: string | null): boolean {
  return theaterId !== null && triageByTheater.has(theaterId);
}

export function setTriageActive(theaterId: string, active: boolean): void {
  if (active) {
    clearFormationView(theaterId);
    if (!triageByTheater.has(theaterId)) {
      if (triageByTheater.size === 0) statusAxisBeforeTriage = getSideBarStatusAxis();
      focusLayerBeforeTriage.set(theaterId, getTheaterFocusLayerSnapshot(theaterId));
      triageByTheater.set(theaterId, true);
      clearedByTheater.set(theaterId, 0);
      enteredAtByTheater.set(theaterId, Date.now());
    }
    setSideBarStatusAxis(true);
    setIdleArrivalAcknowledgementSuspended(triageByTheater.size > 0);
    setTheaterFocusLayerSnapshot(theaterId, null);
    emitTriage();
    return;
  }
  const armChanged = clearTriageSetAsideArm(theaterId);
  if (!triageByTheater.has(theaterId)) {
    setIdleArrivalAcknowledgementSuspended(triageByTheater.size > 0);
    if (armChanged) emitTriage();
    return;
  }
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
  setIdleArrivalAcknowledgementSuspended(triageByTheater.size > 0);
  if (triageByTheater.size === 0) {
    const { activeOperationId, activeOperationAcknowledged } = getState();
    if (activeOperationId !== null && !activeOperationAcknowledged) {
      setActiveOperation(activeOperationId);
    }
    setSideBarStatusAxis(statusAxisBeforeTriage);
  }
  setTheaterFocusLayerSnapshot(theaterId, restoredFocusLayer);
  emitTriage();
}

export function enterTriage(theaterId: string, focusedOperationId: string | null): void {
  const { operations, operationStatus } = getState();
  const theaterOperations = operations.filter((operation) => operation.theaterId === theaterId);
  const focusedOperation = focusedOperationId === null
    ? null
    : theaterOperations.find((operation) => operation.id === focusedOperationId) ?? null;
  if (focusedOperation && isTriageWaitingOperation(focusedOperation, operationStatus)) {
    pickTriageOperation(theaterId, focusedOperation.id);
  }
  setTriageActive(theaterId, true);
  if (resolveTriageQueue(theaterId, theaterOperations, operationStatus).length > 0) return;
  setActiveOperation(null);
  const document = globalThis.document;
  const HTMLElementConstructor = document?.defaultView?.HTMLElement;
  const activeElement = document?.activeElement;
  if (
    HTMLElementConstructor
    && activeElement instanceof HTMLElementConstructor
    && activeElement.closest(".canvas-operation")
  ) {
    activeElement.blur();
  }
}

export function useTriageActive(theaterId: string | null): boolean {
  return useSyncExternalStore(
    subscribeTriage,
    () => isTriageActive(theaterId),
    () => isTriageActive(theaterId),
  );
}

export function pickTriageOperation(theaterId: string, operationId: string): void {
  clearTriageSetAsideArm(theaterId);
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
  clearTriageSetAsideArm(theaterId);
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
  clearTriageSetAsideArm(theaterId);
  operationTheater.set(operationId, theaterId);
  deferredAt.delete(operationId);
  dismissed.add(operationId);
  clearIdleArrival(operationId);
  if (pickedByTheater.get(theaterId) === operationId) pickedByTheater.delete(theaterId);
  emitTriage();
}

export function resetTriageTheater(theaterId: string): void {
  clearTriageSetAsideArm(theaterId);
  const wasActive = triageByTheater.has(theaterId);
  if (wasActive) setTriageActive(theaterId, false);
  else {
    pickedByTheater.delete(theaterId);
    clearedByTheater.delete(theaterId);
    enteredAtByTheater.delete(theaterId);
    focusLayerBeforeTriage.delete(theaterId);
    clearTheaterTransientOperations(theaterId);
    setIdleArrivalAcknowledgementSuspended(triageByTheater.size > 0);
    emitTriage();
  }
}

export function forgetTriageOperation(operationId: string): void {
  const theaterId = operationTheater.get(operationId);
  if (theaterId) clearTriageSetAsideArm(theaterId);
  dismissed.delete(operationId);
  lastClearedAt.delete(operationId);
  deferredAt.delete(operationId);
  seenAt.delete(operationId);
  activityByOperation.delete(operationId);
  clearOperationStatusDetail(operationId);
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

export function armTriageSetAside(theaterId: string, operationId: string): void {
  clearTriageSetAsideArm(theaterId);
  const timer = globalThis.setTimeout(() => {
    const armed = setAsideArmedByTheater.get(theaterId);
    if (!armed || armed.operationId !== operationId || armed.timer !== timer) return;
    setAsideArmedByTheater.delete(theaterId);
    emitTriage();
  }, SET_ASIDE_ARM_DURATION_MS);
  setAsideArmedByTheater.set(theaterId, { operationId, timer });
  emitTriage();
}

export function disarmTriageSetAside(theaterId: string): void {
  if (clearTriageSetAsideArm(theaterId)) emitTriage();
}

export function getTriageSetAsideArmedId(theaterId: string): string | null {
  return setAsideArmedByTheater.get(theaterId)?.operationId ?? null;
}

export function deferTriageOperation(theaterId: string, operationId: string, now = Date.now()): void {
  clearTriageSetAsideArm(theaterId);
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
    if ((activity === "running" || activity === "background" || activity === "dormant") && deferredAt.delete(operation.id)) {
      changed = true;
    }
    if (activityByOperation.get(operation.id) === activity) continue;
    activityByOperation.set(operation.id, activity);
    recordOperationActivityTransition(operation.id, activity, now);
    seenAt.set(operation.id, now);
    changed = true;
  }
  if (!changed) return;
  // 무장은 대상이 대기에서 벗어났을 때만 푼다. 무관한 다른 패널의 상태 전이로 풀면 여러 에이전트가
  // 동시에 도는 동안 두 번째 ↓가 확정 대신 재무장이 되어 키보드만으로는 큐를 끝까지 비울 수 없다.
  const armedId = setAsideArmedByTheater.get(theaterId)?.operationId ?? null;
  if (armedId !== null) {
    const armedOperation = operations.find((operation) => operation.id === armedId) ?? null;
    if (!armedOperation || !isTriageWaitingOperation(armedOperation, operationStatus)) {
      clearTriageSetAsideArm(theaterId);
    }
  }
  emitTriage();
}

export function isTriageClearedTransition(
  previous: OperationActivity | null,
  current: OperationActivity,
): boolean {
  return (previous === "awaiting" || previous === "idle")
    && (current === "running" || current === "background" || current === "dormant");
}

export function isTriageWaitingOperation(
  operation: OperationNode,
  operationStatus: Readonly<Record<string, OperationActivity>>,
): boolean {
  const activity = resolveOperationActivity(operation, operationStatus);
  return activity === "awaiting"
    || (activity === "idle" && getIdleArrivalIds().has(operation.id));
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
    if (previous) disarmTriageSetAside(previous.theaterId);
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
  clearTriageSetAsideArm(theaterId);
  for (const [operationId, ownerTheaterId] of operationTheater) {
    if (ownerTheaterId !== theaterId) continue;
    dismissed.delete(operationId);
    lastClearedAt.delete(operationId);
    deferredAt.delete(operationId);
    seenAt.delete(operationId);
    activityByOperation.delete(operationId);
    operationTheater.delete(operationId);
  }
}

function clearTriageSetAsideArm(theaterId: string): boolean {
  const armed = setAsideArmedByTheater.get(theaterId);
  if (!armed) return false;
  globalThis.clearTimeout(armed.timer);
  setAsideArmedByTheater.delete(theaterId);
  return true;
}

function emitTriage(): void {
  revision += 1;
  for (const listener of listeners) listener();
}
