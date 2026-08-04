import { useSyncExternalStore } from "react";

import type { OperationActivity } from "@fleet-console/sdk/plugin";

import { clearIdleArrival, getIdleArrivalIds, setIdleArrivalAcknowledgementSuspended } from "../operation-idle-arrival.js";
import { resolveOperationActivity } from "../operation-activity.js";
import { clearOperationStatusDetail, recordOperationActivityTransition } from "../operation-status-detail-store.js";
import { getSideBarStatusAxis, setSideBarStatusAxis } from "../sidebar/operations-side-bar-store.js";
import { getState, setActiveOperation } from "../store.js";
import type { OperationGeometry, OperationNode } from "../types.js";
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

// 덱 줌 — theater별 영속(localStorage). 줌 카드 크기는 deck의 inline CSS 변수가 소유하고,
// map 판정(작전지도 LOD)은 카드 최소폭 140px 미만으로 낙찰하는 순간으로 고정한다.
export const TRIAGE_DECK_ZOOM_MIN = 0.35;
export const TRIAGE_DECK_ZOOM_MAX = 2.0;
export const TRIAGE_DECK_ZOOM_DEFAULT = 1.0;
export const TRIAGE_DECK_CARD_BASE_MIN_PX = 260;
export const TRIAGE_DECK_MAP_CARD_MIN_PX = 140;
export const TRIAGE_DECK_ZOOM_PRESETS: readonly number[] = [1.0, 1.6, 0.4];

const TRIAGE_DECK_ZOOM_STORAGE_PREFIX = "fleet-console.triage-deck-zoom.";
const triageDeckZoomByTheater = new Map<string, number>();

export function clampTriageDeckZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return TRIAGE_DECK_ZOOM_DEFAULT;
  return Math.min(TRIAGE_DECK_ZOOM_MAX, Math.max(TRIAGE_DECK_ZOOM_MIN, zoom));
}

export function isTriageDeckMapMode(zoom: number): boolean {
  return Math.round(TRIAGE_DECK_CARD_BASE_MIN_PX * zoom) < TRIAGE_DECK_MAP_CARD_MIN_PX;
}

// in-memory 지도 판정 채널 — 줌 tween은 store 줌을 settle 때만 갱신하므로, 임계 교차는
// tween 프레임마다 여기에 실시간 반영한다. localStorage 기록 없음.
const triageDeckMapModeByTheater = new Map<string, boolean>();

export function isTriageDeckMapModeActive(theaterId: string): boolean {
  return triageDeckMapModeByTheater.get(theaterId) ?? isTriageDeckMapMode(getTriageDeckZoom(theaterId));
}

export function setTriageDeckMapModeLive(theaterId: string, active: boolean): void {
  if (isTriageDeckMapModeActive(theaterId) === active) return;
  triageDeckMapModeByTheater.set(theaterId, active);
  emitTriage();
}

// live 채널은 세션 임시 상태다 — triage 종료/리셋 시 지워 다음 진입이 영속 배율에서 출발한다.
function clearTriageDeckMapModeLive(theaterId: string): void {
  triageDeckMapModeByTheater.delete(theaterId);
}

export function getTriageDeckZoom(theaterId: string): number {
  const cached = triageDeckZoomByTheater.get(theaterId);
  if (cached !== undefined) return cached;
  const zoom = loadTriageDeckZoom(theaterId);
  triageDeckZoomByTheater.set(theaterId, zoom);
  return zoom;
}

export function setTriageDeckZoom(theaterId: string, zoom: number): void {
  const clamped = clampTriageDeckZoom(zoom);
  if (triageDeckZoomByTheater.get(theaterId) === clamped) return;
  triageDeckZoomByTheater.set(theaterId, clamped);
  persistTriageDeckZoom(theaterId, clamped);
  emitTriage();
}

// 프리셋 순환 — 현재 배율과 가장 가까운 프리셋의 다음 항목으로 넘어간다.
export function nextTriageDeckZoomPreset(current: number): number {
  let nearest = 0;
  for (let index = 1; index < TRIAGE_DECK_ZOOM_PRESETS.length; index += 1) {
    if (Math.abs(TRIAGE_DECK_ZOOM_PRESETS[index]! - current) < Math.abs(TRIAGE_DECK_ZOOM_PRESETS[nearest]! - current)) {
      nearest = index;
    }
  }
  return TRIAGE_DECK_ZOOM_PRESETS[(nearest + 1) % TRIAGE_DECK_ZOOM_PRESETS.length]!;
}

function loadTriageDeckZoom(theaterId: string): number {
  try {
    const raw = globalThis.localStorage?.getItem(`${TRIAGE_DECK_ZOOM_STORAGE_PREFIX}${theaterId}`) ?? null;
    if (raw === null) return TRIAGE_DECK_ZOOM_DEFAULT;
    return clampTriageDeckZoom(Number.parseFloat(raw));
  } catch {
    return TRIAGE_DECK_ZOOM_DEFAULT;
  }
}

function persistTriageDeckZoom(theaterId: string, zoom: number): void {
  try {
    globalThis.localStorage?.setItem(`${TRIAGE_DECK_ZOOM_STORAGE_PREFIX}${theaterId}`, String(zoom));
  } catch {
    // Storage is optional.
  }
}

// 작전지도(map mode) 마커 배치 — canvas geometry를 덱 영역 [8,92]%×[10,86]%로 투영하고,
// geometry가 없는 Operation은 id 해시 기반 golden-angle 산포로 채운다. Math.random 금지:
// 렌더마다 위치가 흔들리면 승격 flight의 출발점이 매번 달라진다.
const GOLDEN_ANGLE = 2.399963;
const GOLDEN_FRACTION = 0.61803;
const MAP_MIN_DISTANCE_PCT = 4;
const MAP_RELAXATION_PASSES = 12;

export interface TriageMapMarkerLayout {
  readonly operationId: string;
  readonly x: number;
  readonly y: number;
}

export function resolveTriageMapMarkerLayout(
  operations: ReadonlyArray<Pick<OperationNode, "id"> & { readonly geometry: OperationGeometry | null }>,
): readonly TriageMapMarkerLayout[] {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const operation of operations) {
    if (!operation.geometry) continue;
    const centerX = operation.geometry.x + operation.geometry.width / 2;
    const centerY = operation.geometry.y + operation.geometry.height / 2;
    minX = Math.min(minX, centerX);
    maxX = Math.max(maxX, centerX);
    minY = Math.min(minY, centerY);
    maxY = Math.max(maxY, centerY);
  }

  const points = new Map<string, { x: number; y: number }>();
  for (const operation of operations) {
    if (operation.geometry) {
      // bounding box가 퇴화(폭 또는 높이 0)하면 그 축은 중앙 50%에 고정한다.
      const centerX = operation.geometry.x + operation.geometry.width / 2;
      const centerY = operation.geometry.y + operation.geometry.height / 2;
      const x = maxX > minX ? 8 + ((centerX - minX) / (maxX - minX)) * 84 : 50;
      const y = maxY > minY ? 10 + ((centerY - minY) / (maxY - minY)) * 76 : 48;
      points.set(operation.id, { x, y });
      continue;
    }
    const hashIndex = hashTriageMapKey(operation.id);
    const angle = hashIndex * GOLDEN_ANGLE;
    const radius = 0.18 + 0.28 * ((hashIndex * GOLDEN_FRACTION) % 1);
    points.set(operation.id, {
      x: clampPercent(50 + Math.cos(angle) * radius * 50),
      y: clampPercent(48 + Math.sin(angle) * radius * 50),
    });
  }

  relaxTriageMapMarkers(points);
  return operations.map((operation) => ({
    operationId: operation.id,
    x: points.get(operation.id)!.x,
    y: points.get(operation.id)!.y,
  }));
}

// 결정적 겹침 이완 — 가로세로 등가중 % 평면에서 4% 미만으로 붙은 쌍을 절반씩 밀어낸다.
// 반복 순서가 결과를 바꾸므로 entries는 좌표로 정렬해 입력 배열 순서와 무관하게 만든다.
function relaxTriageMapMarkers(points: Map<string, { x: number; y: number }>): void {
  const entries = [...points.values()].sort((left, right) => left.x - right.x || left.y - right.y);
  if (entries.length < 2) return;
  for (let pass = 0; pass < MAP_RELAXATION_PASSES; pass += 1) {
    let moved = false;
    for (let left = 0; left < entries.length; left += 1) {
      for (let right = left + 1; right < entries.length; right += 1) {
        const a = entries[left]!;
        const b = entries[right]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy);
        if (distance >= MAP_MIN_DISTANCE_PCT) continue;
        moved = true;
        if (distance > 1e-6) {
          const push = (MAP_MIN_DISTANCE_PCT - distance) / 2;
          const ux = dx / distance;
          const uy = dy / distance;
          a.x = clampPercent(a.x - ux * push);
          a.y = clampPercent(a.y - uy * push);
          b.x = clampPercent(b.x + ux * push);
          b.y = clampPercent(b.y + uy * push);
        } else {
          // 완전 일치는 결정적 방향으로만 분리한다 — 무작위 방향이면 렌더마다 흔들린다.
          a.x = clampPercent(a.x - MAP_MIN_DISTANCE_PCT / 2);
          b.x = clampPercent(b.x + MAP_MIN_DISTANCE_PCT / 2);
        }
      }
    }
    if (!moved) return;
  }
}

function clampPercent(value: number): number {
  return Math.min(96, Math.max(4, value));
}

function hashTriageMapKey(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (Math.imul(hash, 31) + key.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

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
  clearTriageDeckMapModeLive(theaterId);
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
    clearTriageDeckMapModeLive(theaterId);
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
