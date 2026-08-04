import { useSyncExternalStore } from "react";

import type { OperationActivity } from "@fleet-console/sdk/plugin";

import { clearIdleArrival, getIdleArrivalIds, setIdleArrivalAcknowledgementSuspended } from "../operation-idle-arrival.js";
import { resolveOperationActivity } from "../operation-activity.js";
import { clearOperationStatusDetail, recordOperationActivityTransition } from "../operation-status-detail-store.js";
import { getState, clearPendingSideBarSignals, setActiveOperation, setActiveTheater } from "../store.js";
import { clearSideBarOperationAction } from "../sidebar/interaction.js";
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

// 선별 처리는 전역 모드다 — 활성/지목/무장/카운트는 Theater와 무관하게 하나만 존재한다.
let triageActive = false;
let pickedOperationId: string | null = null;
let setAsideArmed: {
  readonly operationId: string;
  readonly timer: ReturnType<typeof globalThis.setTimeout>;
} | null = null;
let clearedCount = 0;
let enteredAt: number | null = null;
const lastClearedAt = new Map<string, number>();
const deferredAt = new Map<string, number>();
const dismissed = new Set<string>();
const seenAt = new Map<string, number>();

// 스포트라이트 — localStorage에 단일 전역 토글을 저장한다.
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
// focus layer만 Theater 단위로 유지한다 — 진입 시점 활성 Theater와 선별 중 자동 전환으로
// 방문한 Theater 각각의 스냅샷을 저장해 종료 시 한 번에 복원한다.
const focusLayerBeforeTriage = new Map<string, FocusLayerState | null>();
const listeners = new Set<Listener>();
let revision = 0;

// 덱 줌 — 전역 단일 값. 줌 카드 크기는 deck의 inline CSS 변수가 소유하고,
// map 판정(작전지도 LOD)은 카드 최소폭 140px 미만으로 낙찰하는 순간으로 고정한다.
export const TRIAGE_DECK_ZOOM_MIN = 0.35;
export const TRIAGE_DECK_ZOOM_MAX = 2.0;
export const TRIAGE_DECK_ZOOM_DEFAULT = 1.0;
export const TRIAGE_DECK_CARD_BASE_MIN_PX = 260;
export const TRIAGE_DECK_MAP_CARD_MIN_PX = 140;
export const TRIAGE_DECK_ZOOM_PRESETS: readonly number[] = [1.0, 1.6, 0.4];

const TRIAGE_DECK_ZOOM_STORAGE_KEY = "fleet-console.triage-deck-zoom";
let triageDeckZoom = loadTriageDeckZoom();

export function clampTriageDeckZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return TRIAGE_DECK_ZOOM_DEFAULT;
  return Math.min(TRIAGE_DECK_ZOOM_MAX, Math.max(TRIAGE_DECK_ZOOM_MIN, zoom));
}

export function isTriageDeckMapMode(zoom: number): boolean {
  return Math.round(TRIAGE_DECK_CARD_BASE_MIN_PX * zoom) < TRIAGE_DECK_MAP_CARD_MIN_PX;
}

// in-memory 지도 판정 채널 — 줌 tween은 store 줌을 settle 때만 갱신하므로, 임계 교차는
// tween 프레임마다 여기에 실시간 반영한다. localStorage 기록 없음.
let triageDeckMapModeLive = false;

export function isTriageDeckMapModeActive(): boolean {
  return triageDeckMapModeLive;
}

export function setTriageDeckMapModeLive(active: boolean): void {
  if (triageDeckMapModeLive === active) return;
  triageDeckMapModeLive = active;
  emitTriage();
}

// live 채널은 세션 임시 상태다 — triage 종료/리셋 시 지워 다음 진입이 영속 배율에서 출발한다.
function clearTriageDeckMapModeLive(): void {
  triageDeckMapModeLive = false;
}

export function getTriageDeckZoom(): number {
  return triageDeckZoom;
}

export function setTriageDeckZoom(zoom: number): void {
  const clamped = clampTriageDeckZoom(zoom);
  if (triageDeckZoom === clamped) return;
  triageDeckZoom = clamped;
  persistTriageDeckZoom(clamped);
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

function loadTriageDeckZoom(): number {
  try {
    const raw = globalThis.localStorage?.getItem(TRIAGE_DECK_ZOOM_STORAGE_KEY) ?? null;
    if (raw === null) return TRIAGE_DECK_ZOOM_DEFAULT;
    return clampTriageDeckZoom(Number.parseFloat(raw));
  } catch {
    return TRIAGE_DECK_ZOOM_DEFAULT;
  }
}

function persistTriageDeckZoom(zoom: number): void {
  try {
    globalThis.localStorage?.setItem(TRIAGE_DECK_ZOOM_STORAGE_KEY, String(zoom));
  } catch {
    // Storage is optional.
  }
}

export function resetTriageDeckZoomForTests(): void {
  triageDeckZoom = TRIAGE_DECK_ZOOM_DEFAULT;
  triageDeckMapModeLive = false;
  try {
    globalThis.localStorage?.removeItem(TRIAGE_DECK_ZOOM_STORAGE_KEY);
  } catch {
    // Storage is optional.
  }
  emitTriage();
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

// Formation 진입은 어느 Theater에서든 전역 선별 처리를 끝낸다.
registerBeforeFormationViewActivation(() => setTriageActive(false));

export function isTriageActive(): boolean {
  return triageActive;
}

export function setTriageActive(active: boolean): void {
  if (active) {
    const { activeTheaterId } = getState();
    clearFormationView();
    if (!triageActive) {
      triageActive = true;
      clearedCount = 0;
      enteredAt = Date.now();
    }
    if (activeTheaterId) captureFocusLayerBeforeTriage(activeTheaterId);
    setIdleArrivalAcknowledgementSuspended(true);
    if (activeTheaterId) setTheaterFocusLayerSnapshot(activeTheaterId, null);
    clearPendingSideBarRequests();
    emitTriage();
    return;
  }
  const armChanged = clearTriageSetAsideArm();
  if (!triageActive) {
    if (armChanged) emitTriage();
    return;
  }
  triageActive = false;
  pickedOperationId = null;
  enteredAt = null;
  // 미룸·치워둠 같은 transient 판정은 세션이 아니라 진입에 붙는다 — 껐다 다시 켜면 큐는
  // 미룸·치워둠 없이 처음 순서로 돌아와야 한다(기존 per-Theater 종료의 transient 초기화와 같은 계약).
  deferredAt.clear();
  dismissed.clear();
  lastClearedAt.clear();
  seenAt.clear();
  activityByOperation.clear();
  clearTriageDeckMapModeLive();
  clearPendingSideBarRequests();
  if (getLoadedTheaterId() !== null && getTheaterFocusLayerSnapshot(getLoadedTheaterId()!)?.mode === "companion") {
    forceDropCompanionOperationId();
  }
  const capturedFocusLayers = [...focusLayerBeforeTriage];
  focusLayerBeforeTriage.clear();
  setIdleArrivalAcknowledgementSuspended(false);
  const { activeOperationId, activeOperationAcknowledged } = getState();
  if (activeOperationId !== null && !activeOperationAcknowledged) {
    setActiveOperation(activeOperationId);
  }
  for (const [theaterId, previousFocusLayer] of capturedFocusLayers) {
    // 진입 시점 스냅샷의 복원 조건은 종료 경로와 같다 — 대상 Operation이 아직 존재하고 최소화되지 않았을 때만.
    const canvas = getTheaterCanvasSnapshot(theaterId);
    const restoredFocusLayer = previousFocusLayer
      && canvas.operations[previousFocusLayer.operationId]
      && !canvas.minimized.includes(previousFocusLayer.operationId)
      ? previousFocusLayer
      : null;
    setTheaterFocusLayerSnapshot(theaterId, restoredFocusLayer);
  }
  emitTriage();
}

export function enterTriage(focusedOperationId: string | null): void {
  const { operations, operationStatus } = getState();
  const focusedOperation = focusedOperationId === null
    ? null
    : operations.find((operation) => operation.id === focusedOperationId) ?? null;
  if (focusedOperation && isTriageWaitingOperation(focusedOperation, operationStatus)) {
    pickTriageOperation(focusedOperation.id);
  }
  setTriageActive(true);
  if (resolveTriageQueue(operations, operationStatus).length > 0) return;
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

export function useTriageActive(): boolean {
  return useSyncExternalStore(
    subscribeTriage,
    () => isTriageActive(),
    () => isTriageActive(),
  );
}

// 선별 중 방문하는 모든 Theater에 진입 경로가 활성 Theater에 하는 "캡처 후 null" 쌍을 적용한다 —
// 캡처 없이는 종료 복원 목록에서 빠지고, null 없이는 저장된 companion이 선별 중 부활한다.
export function visitTriageTheater(theaterId: string): void {
  captureFocusLayerBeforeTriage(theaterId);
  setTheaterFocusLayerSnapshot(theaterId, null);
  if (getState().activeTheaterId !== theaterId) setActiveTheater(theaterId);
}

export function pickTriageOperation(operationId: string): void {
  clearTriageSetAsideArm();
  const operation = getState().operations.find((candidate) => candidate.id === operationId) ?? null;
  if (operation) {
    operationTheater.set(operationId, operation.theaterId);
    // 지목 대상이 다른 Theater 소속이면 무대 머신 재사용을 위해 활성 Theater를 전환한다.
    if (operation.theaterId !== getState().activeTheaterId) {
      visitTriageTheater(operation.theaterId);
    }
  }
  dismissed.delete(operationId);
  const wasDeferred = deferredAt.delete(operationId);
  if (pickedOperationId === operationId) {
    if (wasDeferred) emitTriage();
    return;
  }
  pickedOperationId = operationId;
  emitTriage();
}

export function getTriagePick(): string | null {
  return pickedOperationId;
}

export function markTriageCleared(operationId: string): void {
  clearTriageSetAsideArm();
  deferredAt.delete(operationId);
  lastClearedAt.set(operationId, Date.now());
  clearedCount += 1;
  if (pickedOperationId === operationId) pickedOperationId = null;
  emitTriage();
}

export function getTriageCleared(): number {
  return clearedCount;
}

export function dismissTriageOperation(operationId: string): void {
  clearTriageSetAsideArm();
  deferredAt.delete(operationId);
  dismissed.add(operationId);
  clearIdleArrival(operationId);
  if (pickedOperationId === operationId) pickedOperationId = null;
  emitTriage();
}

export function resetTriageTheater(theaterId: string): void {
  // Theater 잊기는 전역 모드를 끄지 않고 그 Theater 소속의 잔여 상태만 걷어낸다.
  if (setAsideArmed !== null && operationTheater.get(setAsideArmed.operationId) === theaterId) {
    clearTriageSetAsideArm();
  }
  if (pickedOperationId !== null && operationTheater.get(pickedOperationId) === theaterId) {
    pickedOperationId = null;
  }
  focusLayerBeforeTriage.delete(theaterId);
  clearTheaterTransientOperations(theaterId);
  emitTriage();
}

export function forgetTriageOperation(operationId: string): void {
  if (setAsideArmed?.operationId === operationId) clearTriageSetAsideArm();
  dismissed.delete(operationId);
  lastClearedAt.delete(operationId);
  deferredAt.delete(operationId);
  seenAt.delete(operationId);
  activityByOperation.delete(operationId);
  clearOperationStatusDetail(operationId);
  operationTheater.delete(operationId);
  if (pickedOperationId === operationId) pickedOperationId = null;
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

export function getTriageEnteredAt(): number | null {
  return enteredAt;
}

export function armTriageSetAside(operationId: string): void {
  clearTriageSetAsideArm();
  const timer = globalThis.setTimeout(() => {
    if (!setAsideArmed || setAsideArmed.operationId !== operationId || setAsideArmed.timer !== timer) return;
    setAsideArmed = null;
    emitTriage();
  }, SET_ASIDE_ARM_DURATION_MS);
  setAsideArmed = { operationId, timer };
  emitTriage();
}

export function disarmTriageSetAside(): void {
  if (clearTriageSetAsideArm()) emitTriage();
}

export function getTriageSetAsideArmedId(): string | null {
  return setAsideArmed?.operationId ?? null;
}

export function deferTriageOperation(operationId: string, now = Date.now()): void {
  clearTriageSetAsideArm();
  let latestDeferredAt = 0;
  for (const timestamp of deferredAt.values()) {
    latestDeferredAt = Math.max(latestDeferredAt, timestamp);
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
  operations: readonly OperationNode[],
  operationStatus: Readonly<Record<string, OperationActivity>>,
  now = Date.now(),
): void {
  let changed = false;
  for (const operation of operations) {
    if (operationTheater.get(operation.id) !== operation.theaterId) {
      operationTheater.set(operation.id, operation.theaterId);
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
  const armedId = setAsideArmed?.operationId ?? null;
  if (armedId !== null) {
    const armedOperation = operations.find((operation) => operation.id === armedId) ?? null;
    if (!armedOperation || !isTriageWaitingOperation(armedOperation, operationStatus)) {
      clearTriageSetAsideArm();
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
  operationId: string,
  shouldClear: () => boolean,
  onSettled: () => void = () => {},
): () => void {
  const timer = globalThis.setTimeout(() => {
    const clear = shouldClear();
    onSettled();
    if (clear) markTriageCleared(operationId);
  }, CLEAR_DELAY_MS);
  return () => globalThis.clearTimeout(timer);
}

export function reconcileTriageStageCompanion(
  previous: TriageStageIdentity | null,
  next: TriageStageIdentity,
): TriageStageIdentity {
  if (previous?.theaterId !== next.theaterId || previous.operationId !== next.operationId) {
    forceDropCompanionOperationId();
    if (previous) disarmTriageSetAside();
  }
  return next;
}

// 전역 큐다 — Theater 필터가 없다. 우선순위(지목=0/복귀=1/awaiting=2/도착=3)·미룸 뒤로·
// seenAt→createdAt→id 타이브레이크는 기존 per-Theater 큐와 같은 규칙을 전 Theater에 걸쳐 적용한다.
export function resolveTriageQueue(
  operations: readonly OperationNode[],
  operationStatus: Readonly<Record<string, OperationActivity>>,
  now = Date.now(),
): readonly TriageQueueEntry[] {
  const candidates: Array<TriageQueueEntry & {
    readonly deferredAt: number | null;
    readonly seenAt: number;
    readonly priority: number;
  }> = [];

  for (const operation of operations) {
    const activity = resolveOperationActivity(operation, operationStatus);
    const picked = operation.id === pickedOperationId;
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

// 선별 중엔 소비자(OperationsSideBar)가 언마운트라 사이드바 요청이 잔류했다가 종료 리마운트에서
// 뒤늦게 실행된다 — 진입·종료 양쪽 경계에서 폐기한다.
function clearPendingSideBarRequests(): void {
  clearPendingSideBarSignals();
  clearSideBarOperationAction();
}

// 선별 중 처음 방문하는 Theater의 focus layer를 한 번만 저장한다 — 종료 시 방문한 모든 Theater를 복원한다.
function captureFocusLayerBeforeTriage(theaterId: string): void {
  if (focusLayerBeforeTriage.has(theaterId)) return;
  focusLayerBeforeTriage.set(theaterId, getTheaterFocusLayerSnapshot(theaterId));
}

function clearTheaterTransientOperations(theaterId: string): void {
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

function clearTriageSetAsideArm(): boolean {
  if (!setAsideArmed) return false;
  globalThis.clearTimeout(setAsideArmed.timer);
  setAsideArmed = null;
  return true;
}

function emitTriage(): void {
  revision += 1;
  for (const listener of listeners) listener();
}
