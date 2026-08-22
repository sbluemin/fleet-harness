import type { OperationActivityVisual } from "../operation-activity.js";
import { useSyncExternalStore } from "react";

import type { OperationRuntimeState } from "@fleet-console/sdk/plugin";

import { clearIdleArrival, clearOperationStatusDetail, getIdleArrivalIds, recordOperationActivityTransition, setIdleArrivalAcknowledgementSuspended } from "../operation-marks.js";
import { resolveOperationActivity, resolveOperationDisplayActivity } from "../operation-activity.js";
import { getState, clearPendingSideBarSignals, registerFocusTheaterSwitchSuppression, setActiveOperation, setActiveTheater } from "../store.js";
import { clearSideBarOperationAction } from "../sidebar/interaction.js";
import type { OperationGeometry, OperationNode } from "../types.js";
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
const TRIAGE_DECK_ZOOM_MIN = 0.35;
const TRIAGE_DECK_ZOOM_MAX = 2.0;
export const TRIAGE_DECK_ZOOM_DEFAULT = 1.0;
export const TRIAGE_DECK_CARD_BASE_MIN_PX = 260;
const TRIAGE_DECK_MAP_CARD_MIN_PX = 140;
const TRIAGE_DECK_ZOOM_PRESETS: readonly number[] = [1.0, 1.6, 0.4];

const TRIAGE_DECK_ZOOM_STORAGE_KEY = "fleet-console.triage-deck-zoom";
let triageDeckZoom: number | null = null;
let triageDeckMapModeLive: boolean | null = null;

export function clampTriageDeckZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return TRIAGE_DECK_ZOOM_DEFAULT;
  return Math.min(TRIAGE_DECK_ZOOM_MAX, Math.max(TRIAGE_DECK_ZOOM_MIN, zoom));
}

export function isTriageDeckMapMode(zoom: number): boolean {
  return Math.round(TRIAGE_DECK_CARD_BASE_MIN_PX * zoom) < TRIAGE_DECK_MAP_CARD_MIN_PX;
}

export function isTriageDeckMapModeActive(): boolean {
  return triageDeckMapModeLive ?? isTriageDeckMapMode(getTriageDeckZoom());
}

export function setTriageDeckMapModeLive(active: boolean): void {
  if (isTriageDeckMapModeActive() === active) return;
  triageDeckMapModeLive = active;
  emitTriage();
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
  triageDeckMapModeLive = null;
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

// 작전지도(map mode) 마커 배치 — 충분한 2D canvas geometry는 덱 영역 [8,92]%×[10,86]%로
// 투영하고, geometry가 부족하거나 거의 한 줄이면 전 Operation을 id 해시 기반 전면 산포로 바꾼다.
// Math.random 금지: 렌더마다 위치가 흔들리면 승격 flight의 출발점이 매번 달라진다.
const GOLDEN_ANGLE = 2.399963;
const GOLDEN_FRACTION = 0.61803;
const MAP_MIN_DISTANCE_PCT = 4;
const MAP_RELAXATION_PASSES = 30;
// 마지막 구간은 최소 간격만 본다 — 이름표 줄 나누기는 그 자체가 점을 다시 붙일 수 있어,
// 끝까지 함께 돌리면 두 제약이 서로를 되돌리며 4% 계약이 미달인 채로 패스가 소진된다.
const MAP_LABEL_RELAXATION_PASSES = 18;
// 이름표가 한 줄로 차지하는 세로 대역과, 같은 줄에 서도 글자가 안 겹치는 최소 가로 간격.
const MAP_LABEL_ROW_PCT = 4.5;
const MAP_LABEL_MIN_DX_PCT = 26;
const TRIAGE_MAP_COLLINEAR_RATIO = 0.12;

export interface TriageMapMarkerLayout {
  readonly operationId: string;
  readonly x: number;
  readonly y: number;
}

export interface TriageFleetZoneLayout {
  readonly theaterId: string;
  /** 원 중심 — 판 가로/세로에 대한 백분율. */
  readonly centerX: number;
  readonly centerY: number;
  /** 원 지름 — 판 높이에 대한 백분율(aspect-ratio 1이 원을 보장한다). */
  readonly size: number;
}

// 작전지도 위 Theater 원형 구역 배치 — 지구본 위 작전구역처럼 원들이 하나의 판에 흩어진다.
// 자리는 결정적 슬롯에서 시작해(렌더마다 흔들리면 지도가 아니라 애니메이션이다) 겹친 쌍을
// 중심선을 따라 밀어내는 분리 반복으로 서로 겹치지 않게 정착시키고, 판이 좁아 다 안 들어가면
// 전체 반지름을 한 단계씩 줄여 다시 정착시킨다. 크기는 함대 규모의 sqrt 비례.
const TRIAGE_FLEET_ZONE_SLOTS: readonly { readonly x: number; readonly y: number }[] = [
  { x: 30, y: 38 },
  { x: 70, y: 32 },
  { x: 50, y: 72 },
  { x: 84, y: 68 },
  { x: 14, y: 70 },
  { x: 58, y: 14 },
  { x: 12, y: 20 },
  { x: 88, y: 18 },
];
const TRIAGE_FLEET_ZONE_GAP = 3;
const TRIAGE_FLEET_ZONE_LABEL_HEADROOM = 8;

export function resolveTriageFleetZoneLayout(
  zones: ReadonlyArray<{ readonly theaterId: string; readonly count: number; readonly slotIndex?: number }>,
  aspect = 1.8,
): readonly TriageFleetZoneLayout[] {
  if (zones.length === 0) return [];
  const safeAspect = Number.isFinite(aspect) && aspect > 0.2 ? Math.min(aspect, 6) : 1.8;
  const width = 100 * safeAspect;
  const total = zones.reduce((sum, zone) => sum + Math.max(1, zone.count), 0) || 1;
  const circles = zones.map((zone, index) => {
    // 슬롯은 Theater 자신의 고정 번호로 고른다 — 입력 순서로 고르면 밴드 정렬이 대기 수를
    // 따라 바뀔 때마다 구역이 서로 자리를 맞바꾼다. 판 위의 자리는 패널 상태가 아니라
    // Theater 정체성에 묶여야 한다(구역 색을 theaterIndex로 고정한 것과 같은 이유).
    const slot = TRIAGE_FLEET_ZONE_SLOTS[(zone.slotIndex ?? index) % TRIAGE_FLEET_ZONE_SLOTS.length]!;
    const share = Math.sqrt(Math.max(1, zone.count) / total);
    // 지름 하한 34%는 라벨+dot 판독, 상한 66%는 이웃 원과의 공존을 지킨다.
    return {
      theaterId: zone.theaterId,
      x: (slot.x / 100) * width,
      y: slot.y,
      r: (34 + share * 32) / 2,
    };
  });
  for (let round = 0; round < 6; round += 1) {
    for (let pass = 0; pass < 24; pass += 1) {
      let moved = false;
      for (let i = 0; i < circles.length; i += 1) {
        for (let j = i + 1; j < circles.length; j += 1) {
          const a = circles[i]!;
          const b = circles[j]!;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.hypot(dx, dy);
          const need = a.r + b.r + TRIAGE_FLEET_ZONE_GAP;
          if (dist >= need) continue;
          // 완전히 포개진 퇴화 케이스는 인덱스 기반 고정 방향으로 밀어 결정성을 지킨다.
          const ux = dist > 0.001 ? dx / dist : (j % 2 === 0 ? 1 : -1);
          const uy = dist > 0.001 ? dy / dist : (i % 2 === 0 ? 0.5 : -0.5);
          const push = (need - Math.max(dist, 0.001)) / 2;
          a.x -= ux * push;
          a.y -= uy * push;
          b.x += ux * push;
          b.y += uy * push;
          moved = true;
        }
      }
      for (const circle of circles) {
        circle.x = Math.min(width - circle.r - 1, Math.max(circle.r + 1, circle.x));
        circle.y = Math.min(100 - circle.r - 1, Math.max(circle.r + TRIAGE_FLEET_ZONE_LABEL_HEADROOM, circle.y));
      }
      if (!moved) break;
    }
    const overlapped = circles.some((a, i) => circles.some((b, j) => j > i
      && Math.hypot(b.x - a.x, b.y - a.y) < a.r + b.r + TRIAGE_FLEET_ZONE_GAP - 0.5));
    if (!overlapped) break;
    for (const circle of circles) circle.r *= 0.88;
  }
  return circles.map((circle) => ({
    theaterId: circle.theaterId,
    centerX: (circle.x / width) * 100,
    centerY: circle.y,
    size: circle.r * 2,
  }));
}

export function resolveTriageMapMarkerLayout(
  operations: ReadonlyArray<Pick<OperationNode, "id"> & { readonly geometry: OperationGeometry | null }>,
  /** 구역 중앙에 Theater 표석이 서는 배치인지 — 표석이 없는 단일 함대(판 전체)는 비워 둘 띠가 없다. */
  reserveLabelBand = false,
): readonly TriageMapMarkerLayout[] {
  const { minX, maxX, minY, maxY, degenerate } = resolveTriageMapBounds(operations);
  const points = new Map<string, { x: number; y: number }>();
  // 손으로 놓은 마커는 그 자리에 고정한다 — 이완도 띠 회피도 이 점은 밀지 않고, 나머지가 비켜간다.
  const pinned = new Set<string>();
  for (const operation of operations) {
    const override = triageMapMarkerOverrides.get(operation.id);
    if (override) {
      points.set(operation.id, { ...override });
      pinned.add(operation.id);
      continue;
    }
    if (!degenerate && operation.geometry) {
      const centerX = operation.geometry.x + operation.geometry.width / 2;
      const centerY = operation.geometry.y + operation.geometry.height / 2;
      const x = 8 + ((centerX - minX) / (maxX - minX)) * 84;
      const y = 10 + ((centerY - minY) / (maxY - minY)) * 76;
      points.set(operation.id, { x, y });
      continue;
    }
    const hashIndex = hashTriageMapKey(operation.id);
    const angle = hashIndex * GOLDEN_ANGLE;
    const radius = Math.sqrt((hashIndex * GOLDEN_FRACTION) % 1);
    points.set(operation.id, {
      x: clampPercent(50 + Math.cos(angle) * radius * 42),
      y: clampPercent(48 + Math.sin(angle) * radius * 38),
    });
  }

  relaxTriageMapMarkers(points, reserveLabelBand, pinned);
  return operations.map((operation) => ({
    operationId: operation.id,
    x: points.get(operation.id)!.x,
    y: points.get(operation.id)!.y,
  }));
}

// 마커 배치가 쓰는 정규화 기준 상자와 그 퇴화 판정 — 배치와 역투영이 같은 함수를 보게 해
// 두 기준이 어긋날 여지를 없앤다. 퇴화(점 3개 미만 또는 거의 한 줄)면 결정적 해시 산포로
// 떨어지므로 상자는 의미가 없다.
function resolveTriageMapBounds(
  operations: ReadonlyArray<{ readonly geometry: OperationGeometry | null }>,
): { minX: number; maxX: number; minY: number; maxY: number; degenerate: boolean } {
  const centers = operations.flatMap((operation) => operation.geometry
    ? [{
        x: operation.geometry.x + operation.geometry.width / 2,
        y: operation.geometry.y + operation.geometry.height / 2,
      }]
    : []);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const center of centers) {
    minX = Math.min(minX, center.x);
    maxX = Math.max(maxX, center.x);
    minY = Math.min(minY, center.y);
    maxY = Math.max(maxY, center.y);
  }
  let degenerate = centers.length < 3;
  if (!degenerate) {
    const meanX = centers.reduce((sum, center) => sum + center.x, 0) / centers.length;
    const meanY = centers.reduce((sum, center) => sum + center.y, 0) / centers.length;
    let covarianceXX = 0;
    let covarianceXY = 0;
    let covarianceYY = 0;
    for (const center of centers) {
      const dx = center.x - meanX;
      const dy = center.y - meanY;
      covarianceXX += dx * dx;
      covarianceXY += dx * dy;
      covarianceYY += dy * dy;
    }
    covarianceXX /= centers.length;
    covarianceXY /= centers.length;
    covarianceYY /= centers.length;
    const halfTrace = (covarianceXX + covarianceYY) / 2;
    const eigenDelta = Math.hypot((covarianceXX - covarianceYY) / 2, covarianceXY);
    const majorSpread = Math.sqrt(Math.max(0, halfTrace + eigenDelta));
    const minorSpread = Math.sqrt(Math.max(0, halfTrace - eigenDelta));
    degenerate = majorSpread === 0 || minorSpread / majorSpread < TRIAGE_MAP_COLLINEAR_RATIO;
  }
  return { minX, maxX, minY, maxY, degenerate };
}

// 사용자가 지도에서 직접 끌어다 놓은 마커 자리. 자동 배치(geometry 투영·해시 산포)보다 세다 —
// 손으로 정한 자리를 다음 렌더가 도로 흩뜨리면 옮길 수 없는 지도와 같다. 판 좌표는 캔버스
// geometry에서 파생되지만 그 역이 항상 성립하지는 않으므로(퇴화 배치에는 되돌릴 원본이 없다)
// 판에서의 자리를 판이 직접 기억한다.
const triageMapMarkerOverrides = new Map<string, { x: number; y: number }>();

export function setTriageMapMarkerOverride(operationId: string, point: { x: number; y: number }): void {
  triageMapMarkerOverrides.set(operationId, { x: clampPercent(point.x), y: clampPercent(point.y) });
  emitTriage();
}

export interface TriageMapProjection {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

// 마커 좌표를 캔버스 좌표로 되돌리기 위한 기준 상자 — 마커 배치가 쓰는 것과 같은 정규화
// 기준이다. 배치가 해시 산포로 떨어지는 경우(geometry 부재·공선)는 되돌릴 원본이 없으므로
// null을 답한다. 그 판정을 호출부가 흉내 내면 두 곳의 기준이 어긋나므로 여기서만 정한다.
export function resolveTriageMapProjection(
  operations: ReadonlyArray<{ readonly geometry: OperationGeometry | null }>,
): TriageMapProjection | null {
  const box = resolveTriageMapBounds(operations);
  return box.degenerate ? null : { minX: box.minX, maxX: box.maxX, minY: box.minY, maxY: box.maxY };
}

// 지도에서 옮긴 만큼 캔버스에서도 옮긴다 — 이동량만 환산하고 원래 좌표에 더한다.
// 마커의 절대 위치를 그대로 역투영하면 안 된다: 화면에 선 마커는 겹침 이완과 표석 띠 회피가
// 이미 옮겨 놓은 자리라 geometry의 직접 투영이 아니다. 그 값을 되돌리면 가로로만 끌어도
// 패널이 세로로 뛴다(띠를 피해 밀려난 만큼). 이동량은 그 왜곡을 타지 않는다.
export function projectTriageMapDeltaToGeometry(
  delta: { readonly x: number; readonly y: number },
  projection: TriageMapProjection,
  geometry: OperationGeometry,
): OperationGeometry {
  const spanX = Math.max(1, projection.maxX - projection.minX);
  const spanY = Math.max(1, projection.maxY - projection.minY);
  return {
    ...geometry,
    x: Math.round(geometry.x + (delta.x / 84) * spanX),
    y: Math.round(geometry.y + (delta.y / 76) * spanY),
  };
}

// Theater 표석이 앉는 구역 중앙의 가로 띠. 마커의 이름표가 점 오른쪽으로 뻗으므로 왼쪽은
// 조금 여유를 두고 오른쪽으로 넓게 잡는다.
const MAP_LABEL_BAND_TOP = 41;
const MAP_LABEL_BAND_BOTTOM = 61;
const MAP_LABEL_BAND_LEFT = 12;
const MAP_LABEL_BAND_RIGHT = 92;

// 표석 자리는 이완이 좌표를 놓을 때마다 함께 지키는 하드 제약이다 — 점과 그 이름표가 Theater
// 문구 위에 겹치면 둘 다 읽히지 않는다. 이완이 끝난 뒤 한 번 스냅하는 방식은 그 스냅이 직전에
// 확보한 최소 간격을 도로 무너뜨린다(띠 아래 절반의 점을 위로 올리면 그 위 이웃과 다시 붙는다).
// 띠 밖으로는 세로로 낸다 — 가로 이동은 소속 구역을 벗어나기 쉽다.
function placeTriageMapPoint(
  point: { x: number; y: number },
  x: number,
  y: number,
  reserveLabelBand: boolean,
): void {
  point.x = clampPercent(x);
  point.y = clampPercent(y);
  if (!reserveLabelBand) return;
  if (point.y <= MAP_LABEL_BAND_TOP || point.y >= MAP_LABEL_BAND_BOTTOM) return;
  if (point.x <= MAP_LABEL_BAND_LEFT || point.x >= MAP_LABEL_BAND_RIGHT) return;
  const bandCenter = (MAP_LABEL_BAND_TOP + MAP_LABEL_BAND_BOTTOM) / 2;
  point.y = clampPercent(point.y < bandCenter ? MAP_LABEL_BAND_TOP - 1 : MAP_LABEL_BAND_BOTTOM + 1);
}

// 결정적 겹침 이완 — 가로세로 등가중 % 평면에서 4% 미만으로 붙은 쌍을 절반씩 밀어낸다.
// 반복 순서가 결과를 바꾸므로 entries는 좌표로 정렬해 입력 배열 순서와 무관하게 만든다.
function relaxTriageMapMarkers(
  points: Map<string, { x: number; y: number }>,
  reserveLabelBand = false,
  pinned: ReadonlySet<string> = new Set(),
): void {
  const entries = [...points.entries()]
    .map(([operationId, point]) => ({ point, pinned: pinned.has(operationId) }))
    .sort((left, right) => left.point.x - right.point.x || left.point.y - right.point.y);
  if (entries.length === 0) return;
  // 초기 배치가 이미 띠를 밟고 있을 수 있다 — 이완 전에 제자리에서 한 번 투영해 둔다.
  // 손으로 놓은 자리는 띠 위라도 존중한다: 사용자가 보면서 정한 자리다.
  for (const entry of entries) {
    if (entry.pinned) continue;
    placeTriageMapPoint(entry.point, entry.point.x, entry.point.y, reserveLabelBand);
  }
  if (entries.length < 2) return;
  for (let pass = 0; pass < MAP_RELAXATION_PASSES; pass += 1) {
    let moved = false;
    for (let left = 0; left < entries.length; left += 1) {
      for (let right = left + 1; right < entries.length; right += 1) {
        const first = entries[left]!;
        const second = entries[right]!;
        if (first.pinned && second.pinned) continue;
        const a = first.point;
        const b = second.point;
        // 고정된 쪽은 제자리에 두고 상대만 그만큼 더 비켜간다 — 둘로 나눠 밀면 고정이 풀린다.
        const shiftA = first.pinned ? 0 : (second.pinned ? 2 : 1);
        const shiftB = second.pinned ? 0 : (first.pinned ? 2 : 1);
        const nudge = (
          entry: { point: { x: number; y: number }; pinned: boolean },
          x: number,
          y: number,
        ) => {
          if (entry.pinned) return;
          placeTriageMapPoint(entry.point, x, y, reserveLabelBand);
        };
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy);
        if (distance < MAP_MIN_DISTANCE_PCT) {
          moved = true;
          if (distance > 1e-6) {
            const push = (MAP_MIN_DISTANCE_PCT - distance) / 2;
            const ux = dx / distance;
            const uy = dy / distance;
            nudge(first, a.x - ux * push * shiftA, a.y - uy * push * shiftA);
            nudge(second, b.x + ux * push * shiftB, b.y + uy * push * shiftB);
          } else {
            // 완전 일치는 결정적 방향으로만 분리한다 — 무작위 방향이면 렌더마다 흔들린다.
            nudge(first, a.x - (MAP_MIN_DISTANCE_PCT / 2) * shiftA, a.y);
            nudge(second, b.x + (MAP_MIN_DISTANCE_PCT / 2) * shiftB, b.y);
          }
          continue;
        }
        // 점끼리 떨어져 있어도 이름표는 겹친다 — 이름표는 점 오른쪽으로 길게 뻗으므로, 같은
        // 줄에 선 두 점은 가로로 한참 벌어져야 글자가 안 포개진다. 먼저 세로로 벌린다(줄만
        // 달라지면 겹침이 끝난다). 띠나 판 가장자리에 막혀 줄이 갈리지 않으면 가로로 민다.
        // 후반 패스에서는 이 규칙을 끈다 — 줄 나누기는 점을 다시 붙일 수 있어, 끝까지 함께
        // 돌리면 4% 간격 계약이 미달인 채로 패스가 소진된다. 마지막은 간격만 보고 수렴시킨다.
        if (pass >= MAP_LABEL_RELAXATION_PASSES) continue;
        if (Math.abs(dy) >= MAP_LABEL_ROW_PCT || Math.abs(dx) >= MAP_LABEL_MIN_DX_PCT) continue;
        moved = true;
        const rowPush = (MAP_LABEL_ROW_PCT - Math.abs(dy)) / 2 + 0.35;
        const direction = dy >= 0 ? 1 : -1;
        const beforeGap = Math.abs(dy);
        nudge(first, a.x, a.y - direction * rowPush * shiftA);
        nudge(second, b.x, b.y + direction * rowPush * shiftB);
        if (Math.abs(b.y - a.y) > beforeGap + 1e-6) continue;
        const columnPush = (MAP_LABEL_MIN_DX_PCT - Math.abs(dx)) / 2;
        const columnDirection = dx >= 0 ? 1 : -1;
        nudge(first, a.x - columnDirection * columnPush * shiftA, a.y);
        nudge(second, b.x + columnDirection * columnPush * shiftB, b.y);
      }
    }
    if (!moved) return;
  }
}

export function clampTriageMapPercent(value: number): number {
  return clampPercent(value);
}

function clampPercent(value: number): number {
  return Math.min(96, Math.max(4, value));
}

export function hashTriageMapKey(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (Math.imul(hash, 31) + key.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
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
  triageDeckMapModeLive = null;
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
