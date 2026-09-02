import type { OperationActivityVisual } from "../operation-activity.js";
import { useSyncExternalStore } from "react";

import type { OperationRuntimeState } from "@fleet-console/sdk/plugin";

import { clearIdleArrival, clearOperationStatusDetail, getIdleArrivalIds, recordOperationActivityTransition, setIdleArrivalAcknowledgementSuspended } from "../operation-marks.js";
import { resolveOperationActivity, resolveOperationDisplayActivity } from "../operation-activity.js";
import { getState, clearPendingSideBarSignals, registerFocusTheaterSwitchSuppression, setActiveOperation, setActiveTheater } from "../store.js";
import { clearSideBarOperationAction } from "../sidebar/interaction.js";
import type { OperationNode } from "../types.js";
import { readCanvasModeSession, rememberWarRoomActive } from "./canvas-mode-session.js";
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
  readonly activity: OperationActivityVisual;
  readonly picked: boolean;
}

export interface TriageStageIdentity {
  readonly theaterId: string;
  readonly operationId: string | null;
}

const RETURN_WINDOW_MS = 10_000;
const CLEAR_DELAY_MS = 600;
// 패널/사이드바 닫기의 1500ms 확인과 같은 두 번 눌러 확정 문법이라, 확인 시간이 달라지면 학습이 깨진다.
const SET_ASIDE_ARM_DURATION_MS = 1500;

// 선별 처리는 전역 모드다 — 활성/지목/무장/카운트는 Theater와 무관하게 하나만 존재한다.
let triageActive = false;
let pickedOperationId: string | null = null;
let setAsideArmed: {
  readonly operationId: string;
  readonly timer: ReturnType<typeof globalThis.setTimeout>;
} | null = null;
let enteredAt: number | null = null;
// 선별 중 마지막으로 무대에 올랐던 Operation의 Theater — 종료 시 이 Theater로 복귀한다.
let lastStagedTheaterId: string | null = null;
const lastClearedAt = new Map<string, number>();
const deferredAt = new Map<string, number>();
const dismissed = new Set<string>();
const seenAt = new Map<string, number>();
// 캡션으로만 활성화된 패널이 대기로 전이하면 무대 후보로 남을 자격이 생긴다.
// pick이 아니다 — 미룸·치워둠·무장을 건드리지 않고, 스포트라이트 OFF 자동 등단도 강제하지 않는다.
let activeAwaitingClaimId: string | null = null;

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

const activityByOperation = new Map<string, OperationActivityVisual>();
const waitingByOperation = new Map<string, boolean>();
const operationTheater = new Map<string, string>();
// focus layer만 Theater 단위로 유지한다 — 진입 시점 활성 Theater와 선별 중 자동 전환으로
// 방문한 Theater 각각의 스냅샷을 저장해 종료 시 한 번에 복원한다.
const focusLayerBeforeTriage = new Map<string, FocusLayerState | null>();
const listeners = new Set<Listener>();
let revision = 0;

// 덱 줌은 전역 선별 처리와 같은 단일 영속 값이다. 카드 크기는 deck의 inline CSS 변수가 소유하고,
// map 판정(작전지도 LOD)은 카드 최소폭 140px 미만으로 낙찰하는 순간으로 고정한다.
// 덱 밀도는 1×~2×다 — 1× 아래는 카드가 읽히지 않는 구간이라 덱은 거기로 내려가지 않는다.
// 함대 전체를 점으로 보는 판은 Cruise 캔버스가 축소 임계에서 스스로 세운다(fleet-map).
const TRIAGE_DECK_ZOOM_MIN = 1.0;
const TRIAGE_DECK_ZOOM_MAX = 2.0;
export const TRIAGE_DECK_ZOOM_DEFAULT = 1.0;
export const TRIAGE_DECK_CARD_BASE_MIN_PX = 260;
const TRIAGE_DECK_ZOOM_PRESETS: readonly number[] = [1.0, 1.6];

const TRIAGE_DECK_ZOOM_STORAGE_KEY = "fleet-console.triage-deck-zoom";
let triageDeckZoom: number | null = null;

export function clampTriageDeckZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return TRIAGE_DECK_ZOOM_DEFAULT;
  return Math.min(TRIAGE_DECK_ZOOM_MAX, Math.max(TRIAGE_DECK_ZOOM_MIN, zoom));
}

// 표시용 실시간 배율 — store 줌은 tween settle 때만 갱신되므로, 커맨드 밴드의 배율 표시는
// 이 채널을 읽어야 tween을 따라간다. 영속 줌과 같은 지연 초기화 규약을 쓴다(null = 아직 없음).
let triageDeckZoomLive: number | null = null;

export function getTriageDeckZoomLive(): number {
  return triageDeckZoomLive ?? getTriageDeckZoom();
}

export function setTriageDeckZoomLive(zoom: number): void {
  if (getTriageDeckZoomLive() === zoom) return;
  triageDeckZoomLive = zoom;
  emitTriage();
}

export function useTriageDeckZoomLive(): number {
  return useSyncExternalStore(subscribeTriage, getTriageDeckZoomLive, getTriageDeckZoomLive);
}

export function getTriageDeckZoom(): number {
  if (triageDeckZoom !== null) return triageDeckZoom;
  triageDeckZoom = loadTriageDeckZoom();
  return triageDeckZoom;
}

export function setTriageDeckZoom(zoom: number): void {
  const clamped = clampTriageDeckZoom(zoom);
  if (getTriageDeckZoom() === clamped) return;
  triageDeckZoom = clamped;
  persistTriageDeckZoom(clamped);
  emitTriage();
}

export function resetTriageDeckZoomForTests(): void {
  triageDeckZoom = null;
  triageDeckZoomLive = null;
  try {
    globalThis.localStorage?.removeItem(TRIAGE_DECK_ZOOM_STORAGE_KEY);
  } catch {
    // Storage is optional.
  }
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

// 선별 중 검색·ALERTS·스위처의 focusOperation은 Theater를 전환하지 않는다 — 전 Theater가
// 마운트이므로 지목만으로 무대가 서고, 전환하면 목적지의 저장 focus layer가 부활한다.
registerFocusTheaterSwitchSuppression(() => triageActive);

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
      rememberWarRoomActive(true);
      enteredAt = Date.now();
      lastStagedTheaterId = null;
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
  rememberWarRoomActive(false);
  pickedOperationId = null;
  activeAwaitingClaimId = null;
  enteredAt = null;
  // 미룸·치워둠 같은 transient 판정은 세션이 아니라 진입에 붙는다 — 껐다 다시 켜면 큐는
  // 미룸·치워둠 없이 처음 순서로 돌아와야 한다(기존 per-Theater 종료의 transient 초기화와 같은 계약).
  deferredAt.clear();
  dismissed.clear();
  lastClearedAt.clear();
  seenAt.clear();
  activityByOperation.clear();
  // waitingByOperation은 전이 판정용 baseline이다. recordTriageActivity가 선별 밖에서도
  // 갱신하므로 여기서 지우면 재진입 직후 첫 대기가 previousWaiting===undefined로 침묵한다.
  clearPendingSideBarRequests();
  if (getLoadedTheaterId() !== null && getTheaterFocusLayerSnapshot(getLoadedTheaterId()!)?.mode === "companion") {
    forceDropCompanionOperationId();
  }
  triageDeckZoomLive = null;
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
  // 종료 시 활성 Theater는 마지막으로 무대에 올랐던 Theater로 복귀한다(무대 이력이 없으면 유지).
  const returnTheaterId = lastStagedTheaterId;
  lastStagedTheaterId = null;
  if (returnTheaterId !== null
    && getState().activeTheaterId !== returnTheaterId
    && getState().theaters.some((theater) => theater.id === returnTheaterId)) {
    setActiveTheater(returnTheaterId);
  }
  emitTriage();
}

// 탭 세션에 War Room이 적혀 있으면 부팅 시 그 모드로 되돌린다 — 콘솔을 오갔을 때 사용자가 서 있던
// 모드가 Cruise로 리셋되지 않게 하는 유일한 복원 지점이다. 큐 판정(미룸·치워둠)은 진입에 붙는
// transient 상태라 복원하지 않는다: 되살아나는 것은 모드뿐이고 큐는 처음 순서로 다시 선다.
export function restoreTriageSession(): boolean {
  if (triageActive) return false;
  if (!readCanvasModeSession().warRoom) return false;
  setTriageActive(true);
  return true;
}

export function enterTriage(focusedOperationId: string | null): void {
  const { operations, operationRuntime } = getState();
  const focusedOperation = focusedOperationId === null
    ? null
    : operations.find((operation) => operation.id === focusedOperationId) ?? null;
  if (focusedOperation && isTriageWaitingOperation(focusedOperation, operationRuntime)) {
    pickTriageOperation(focusedOperation.id);
  }
  setTriageActive(true);
  if (resolveTriageQueue(operations, operationRuntime).length > 0) return;
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

// 선별 중 사용자가 수동으로 Theater를 전환할 때(스위처·팔레트) 진입 경로가 활성 Theater에
// 하는 "캡처 후 null" 쌍을 적용한다 — 캡처 없이는 종료 복원 목록에서 빠지고, null 없이는
// 저장된 companion이 선별 중 부활한다. 무대 승격은 전 Theater 마운트라 전환 자체가 없다.
export function visitTriageTheater(theaterId: string): void {
  captureFocusLayerBeforeTriage(theaterId);
  setTheaterFocusLayerSnapshot(theaterId, null);
  // 방문 Theater에 남아 있던 Formation 플래그는 loadForTheater가 그대로 복원해
  // 선별과 Formation의 상호배제를 깬다 — 진입 경로처럼 목적지의 Formation도 걷어낸다.
  clearFormationView(theaterId);
  if (getState().activeTheaterId !== theaterId) setActiveTheater(theaterId);
}

// 종료 시 복귀할 "마지막으로 무대에 올랐던 Theater" 이력 — canvas가 무대가 설 때 기록한다.
export function recordTriageStageTheater(theaterId: string): void {
  lastStagedTheaterId = theaterId;
}

export function pickTriageOperation(operationId: string): void {
  clearTriageSetAsideArm();
  const operation = getState().operations.find((candidate) => candidate.id === operationId) ?? null;
  // 전 Theater가 마운트되므로 지목은 Theater를 전환하지 않는다 — 무대가 소속 무관하게 선다.
  if (operation) operationTheater.set(operationId, operation.theaterId);
  dismissed.delete(operationId);
  const wasDeferred = deferredAt.delete(operationId);
  const claimDropped = activeAwaitingClaimId !== null && activeAwaitingClaimId !== operationId;
  if (claimDropped) activeAwaitingClaimId = null;
  if (pickedOperationId === operationId) {
    if (wasDeferred || claimDropped) emitTriage();
    return;
  }
  pickedOperationId = operationId;
  emitTriage();
}

export function getTriagePick(): string | null {
  return pickedOperationId;
}

export function getActiveAwaitingClaimId(): string | null {
  return activeAwaitingClaimId;
}

export function resolveActiveAwaitingTriageEntry(
  operations: readonly OperationNode[],
  operationRuntime: Readonly<Record<string, OperationRuntimeState>>,
): TriageQueueEntry | null {
  if (activeAwaitingClaimId === null) return null;
  const operation = operations.find((candidate) => candidate.id === activeAwaitingClaimId) ?? null;
  if (!operation
    || getState().activeOperationId !== operation.id
    || !isTriageWaitingOperation(operation, operationRuntime)
    || dismissed.has(operation.id)
    || deferredAt.has(operation.id)) {
    return null;
  }
  return {
    operation,
    activity: resolveOperationActivity(operation, operationRuntime),
    picked: false,
  };
}

// 빈곳 해제는 operations/runtime을 바꾸지 않아 recordTriageActivity가 안 돈다.
// 활성이 떠난 클레임을 여기서 거두지 않으면, 같은 패널을 다시 캡션만 눌러도
// 전이가 없는데 무대 후보가 되살아난다.
export function releaseInactiveActiveAwaitingClaim(): void {
  if (activeAwaitingClaimId === null) return;
  if (getState().activeOperationId === activeAwaitingClaimId) return;
  activeAwaitingClaimId = null;
  emitTriage();
}

export function markTriageCleared(operationId: string): void {
  clearTriageSetAsideArm();
  deferredAt.delete(operationId);
  lastClearedAt.set(operationId, Date.now());
  if (pickedOperationId === operationId) pickedOperationId = null;
  if (activeAwaitingClaimId === operationId) activeAwaitingClaimId = null;
  emitTriage();
}

export function dismissTriageOperation(operationId: string): void {
  clearTriageSetAsideArm();
  deferredAt.delete(operationId);
  dismissed.add(operationId);
  clearIdleArrival(operationId);
  if (pickedOperationId === operationId) pickedOperationId = null;
  if (activeAwaitingClaimId === operationId) activeAwaitingClaimId = null;
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
  if (activeAwaitingClaimId !== null && operationTheater.get(activeAwaitingClaimId) === theaterId) {
    activeAwaitingClaimId = null;
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
  waitingByOperation.delete(operationId);
  clearOperationStatusDetail(operationId);
  operationTheater.delete(operationId);
  if (pickedOperationId === operationId) pickedOperationId = null;
  if (activeAwaitingClaimId === operationId) activeAwaitingClaimId = null;
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
  if (activeAwaitingClaimId === operationId) activeAwaitingClaimId = null;
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
  operationRuntime: Readonly<Record<string, OperationRuntimeState>>,
  now = Date.now(),
): void {
  let changed = false;
  const { activeOperationId } = getState();
  for (const operation of operations) {
    if (operationTheater.get(operation.id) !== operation.theaterId) {
      operationTheater.set(operation.id, operation.theaterId);
      changed = true;
    }
    const activity = resolveOperationActivity(operation, operationRuntime);
    const waiting = isTriageWaitingOperation(operation, operationRuntime);
    if ((activity === "running" || activity === "background" || activity === "ended") && deferredAt.delete(operation.id)) {
      changed = true;
    }
    const previousWaiting = waitingByOperation.get(operation.id);
    if (previousWaiting === waiting && activityByOperation.get(operation.id) === activity) continue;
    // 선별 중 이미 활성인 패널이 대기로 들어설 때만 클레임을 남긴다. 캡션 클릭 자체는
    // 여기 오지 않고, pick도 아니다 — 미룸·치워둠·무장을 그대로 둔다.
    if (
      triageActive
      && previousWaiting === false
      && waiting
      && operation.id === activeOperationId
      && !dismissed.has(operation.id)
      && !deferredAt.has(operation.id)
    ) {
      activeAwaitingClaimId = operation.id;
    } else if (activeAwaitingClaimId === operation.id && !waiting) {
      activeAwaitingClaimId = null;
    }
    waitingByOperation.set(operation.id, waiting);
    if (activityByOperation.get(operation.id) !== activity) {
      activityByOperation.set(operation.id, activity);
      recordOperationActivityTransition(operation.id, activity, now);
      seenAt.set(operation.id, now);
    }
    changed = true;
  }
  if (activeAwaitingClaimId !== null && !operations.some((operation) => operation.id === activeAwaitingClaimId)) {
    activeAwaitingClaimId = null;
    changed = true;
  }
  if (!changed) return;
  // 무장은 대상이 대기에서 벗어났을 때만 푼다. 무관한 다른 패널의 상태 전이로 풀면 여러 에이전트가
  // 동시에 도는 동안 두 번째 ↓가 확정 대신 재무장이 되어 키보드만으로는 큐를 끝까지 비울 수 없다.
  const armedId = setAsideArmed?.operationId ?? null;
  if (armedId !== null) {
    const armedOperation = operations.find((operation) => operation.id === armedId) ?? null;
    if (!armedOperation || !isTriageWaitingOperation(armedOperation, operationRuntime)) {
      clearTriageSetAsideArm();
    }
  }
  emitTriage();
}

export function isTriageClearedTransition(
  previous: OperationActivityVisual | null,
  current: OperationActivityVisual,
): boolean {
  return (previous === "awaiting" || previous === "idle")
    && (current === "running" || current === "background" || current === "ended");
}

export function isTriageWaitingOperation(
  operation: OperationNode,
  operationRuntime: Readonly<Record<string, OperationRuntimeState>>,
): boolean {
  return resolveOperationDisplayActivity({
    activity: resolveOperationActivity(operation, operationRuntime),
    operationId: operation.id,
    idleArrivalIds: getIdleArrivalIds(),
  }) === "awaiting";
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
  operationRuntime: Readonly<Record<string, OperationRuntimeState>>,
  now = Date.now(),
): readonly TriageQueueEntry[] {
  const candidates: Array<TriageQueueEntry & {
    readonly deferredAt: number | null;
    readonly seenAt: number;
    readonly priority: number;
  }> = [];
  // 최소화는 "지금 보는 판에서 내린다"는 뜻이므로 deck에서 내려간 Operation은 순번에도 남지 않는다.
  // 지목(picked)보다 앞서 판정한다 — 무대에 선 패널을 최소화하면 무대까지 비우는 것이 정의다.
  const minimizedByTheater = new Map<string, ReadonlySet<string>>();
  const isMinimized = (operation: OperationNode): boolean => {
    let ids = minimizedByTheater.get(operation.theaterId);
    if (!ids) {
      ids = new Set(getTheaterCanvasSnapshot(operation.theaterId).minimized);
      minimizedByTheater.set(operation.theaterId, ids);
    }
    return ids.has(operation.id);
  };

  for (const operation of operations) {
    if (isMinimized(operation)) continue;
    const activity = resolveOperationActivity(operation, operationRuntime);
    const picked = operation.id === pickedOperationId;
    if (!picked && dismissed.has(operation.id)) continue;
    if (!picked && !isTriageWaitingOperation(operation, operationRuntime)) continue;
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
    waitingByOperation.delete(operationId);
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
