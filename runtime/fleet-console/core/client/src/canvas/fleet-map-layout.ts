import type { CSSProperties } from "react";

import type { OperationGeometry, OperationNode } from "../types.js";

// 함대 지도 — Cruise 캔버스가 판독 한계 아래로 축소되면 패널 대신 서는 판. 이 모듈은 그 판의
// 순수 배치만 안다: 언제 서는지(줌 히스테리시스), Theater 구역이 어디에 놓이는지, 구역 안에서
// 점이 어디에 서는지. 그리는 것은 fleet-map.tsx, 켜고 끄는 것은 canvas.tsx다.
//
// 임계는 War Room 덱이 지도로 낙찰하던 그 판독 경계를 잇는다 — 덱은 260px 카드가 140px 아래로
// 내려가면 지도였다. Cruise에서 흔한 800px 패널은 줌 0.2에서 160px, 최소 폭 320px 패널은 64px라
// 이 아래에서는 캡션도 본문도 읽히지 않는다. 두 값 모두 focusOperation의 줌 하한(0.25)보다
// 낮게 둔다 — 어떤 포커스 점프도 지도를 벗어난다는 계약이 그 한 줄로 선다.
export const FLEET_MAP_ENTER_ZOOM = 0.2;
export const FLEET_MAP_EXIT_ZOOM = 0.24;

// 축소의 바닥 — 판이 반드시 서 있는 첫 배율이다(진입 임계 바로 아래). 함대가 점으로 잦아든
// 뒤의 추가 축소는 아무 정보도 더 주지 못한다: 판은 화면 고정 층이라 그대로고, 바다만 계속
// 옅어진다. 그 구간을 열어 두면 "끝까지 축소했다"는 감각이 사라지고, 되돌아오는 데 휠 노치만
// 늘어난다. 그래서 휠 축소는 이 층에서 멈춘다.
export const FLEET_MAP_FLOOR_ZOOM = 0.19;

/** 휠 축소가 내려갈 수 있는 하한. 상수 하나로 고정하지 않는 이유는 fit-all(FIT_ALL_MIN_ZOOM
 *  0.02)이 판보다 깊은 배율로 뷰포트를 데려갈 수 있기 때문이다 — 그 자리에서 하한을 0.19로
 *  들이대면 축소 휠이 하한으로 튀어 올라 방향이 뒤집힌다. 이미 바닥보다 깊은 뷰포트에서는
 *  그 자리를 바닥으로 삼아, 축소는 정지하고 확대만 열어 둔다. */
export function resolveWheelZoomFloor(currentZoom: number): number {
  if (!Number.isFinite(currentZoom) || currentZoom <= 0) return FLEET_MAP_FLOOR_ZOOM;
  return Math.min(FLEET_MAP_FLOOR_ZOOM, currentZoom);
}

/** 줌 히스테리시스 — 진입은 0.2 미만, 이탈은 0.24 초과. 경계 위에서 휠 한 노치가 판을 두 번
 *  뒤집지 않게 한다. previous는 직전 판정(캔버스가 ref로 든다). */
export function resolveFleetMapActive(previous: boolean, zoom: number): boolean {
  if (!Number.isFinite(zoom)) return false;
  return previous ? zoom <= FLEET_MAP_EXIT_ZOOM : zoom < FLEET_MAP_ENTER_ZOOM;
}

/** 판이 서 있는 동안 보이는 패널들의 월드 중심 — 지도 위의 줌은 커서가 아니라 이 점을 앵커로
 *  잡는다. 판 위의 커서는 월드와 아무 관계가 없어, 커서 앵커로 확대하면 함대가 화면 밖으로
 *  흘러간 채 패널이 돌아온다(핸드오프 1차 피드백). 최소화된 패널은 화면에 없으니 제외한다. */
export function resolveFleetContentCenter(
  operations: Readonly<Record<string, OperationGeometry>>,
  minimized: readonly string[],
): { readonly x: number; readonly y: number } | null {
  const hidden = new Set(minimized);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [operationId, geometry] of Object.entries(operations)) {
    if (hidden.has(operationId)) continue;
    minX = Math.min(minX, geometry.x);
    minY = Math.min(minY, geometry.y);
    maxX = Math.max(maxX, geometry.x + geometry.width);
    maxY = Math.max(maxY, geometry.y + geometry.height);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/** 월드의 한 점을 아레나의 한 화면 점(아레나-상대) 아래에 놓는 저장 viewport. 화면 점을 주지
 *  않으면 아레나 중앙이다. */
export function anchorViewportToPoint(
  point: { readonly x: number; readonly y: number },
  zoom: number,
  arena: { readonly width: number; readonly height: number },
  screen?: { readonly x: number; readonly y: number },
): { readonly x: number; readonly y: number; readonly zoom: number } {
  const at = screen ?? { x: arena.width / 2, y: arena.height / 2 };
  return {
    x: at.x - point.x * zoom,
    y: at.y - point.y * zoom,
    zoom,
  };
}

export interface FleetMapZoomCandidate {
  readonly operationId: string;
  /** 판 위 점의 화면 좌표(캔버스-local). */
  readonly screen: { readonly x: number; readonly y: number };
  /** 그 Operation의 월드 중심. */
  readonly center: { readonly x: number; readonly y: number };
}

/** 판 위에서 확대할 때의 앵커 — 커서에 가장 가까운 점의 Operation. 판은 함대의 축소판이라
 *  커서가 겨눈 점이 곧 "여기로 내려가겠다"는 뜻이고, 그 Operation을 커서 아래 두고 키우면
 *  판이 걷힌 뒤에도 커서 주위로 계속 자란다. 후보가 없으면(활성 Theater가 비었으면) null —
 *  호출부는 함대 중심을 아레나 중앙에 둔다. */
export function resolveFleetMapZoomAnchor(
  candidates: readonly FleetMapZoomCandidate[],
  cursor: { readonly x: number; readonly y: number },
): FleetMapZoomCandidate | null {
  let nearest: FleetMapZoomCandidate | null = null;
  let best = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.hypot(candidate.screen.x - cursor.x, candidate.screen.y - cursor.y);
    if (distance < best) {
      best = distance;
      nearest = candidate;
    }
  }
  return nearest;
}

// 마커 배치 — 충분한 2D canvas geometry는 필드 [8,92]%×[10,86]%로 투영하고, geometry가 부족하거나
// 거의 한 줄이면 전 Operation을 id 해시 기반 전면 산포로 바꾼다.
// Math.random 금지: 렌더마다 위치가 흔들리면 지도가 아니라 애니메이션이다.
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
const MAP_COLLINEAR_RATIO = 0.12;

export interface FleetMapMarkerLayout {
  readonly operationId: string;
  readonly x: number;
  readonly y: number;
}

export interface FleetMapZoneLayout {
  readonly theaterId: string;
  /** 원 중심 — 판 가로/세로에 대한 백분율. */
  readonly centerX: number;
  readonly centerY: number;
  /** 원 지름 — 판 높이에 대한 백분율(aspect-ratio 1이 원을 보장한다). */
  readonly size: number;
}

// Theater 원형 구역 배치 — 지구본 위 작전구역처럼 원들이 하나의 판에 흩어진다.
// 자리는 결정적 슬롯에서 시작해(렌더마다 흔들리면 지도가 아니라 애니메이션이다) 겹친 쌍을
// 중심선을 따라 밀어내는 분리 반복으로 서로 겹치지 않게 정착시키고, 판이 좁아 다 안 들어가면
// 전체 반지름을 한 단계씩 줄여 다시 정착시킨다. 크기는 함대 규모의 sqrt 비례.
const FLEET_ZONE_SLOTS: readonly { readonly x: number; readonly y: number }[] = [
  { x: 30, y: 38 },
  { x: 70, y: 32 },
  { x: 50, y: 72 },
  { x: 84, y: 68 },
  { x: 14, y: 70 },
  { x: 58, y: 14 },
  { x: 12, y: 20 },
  { x: 88, y: 18 },
];
const FLEET_ZONE_GAP = 3;
const FLEET_ZONE_LABEL_HEADROOM = 8;

export function resolveFleetMapZoneLayout(
  zones: ReadonlyArray<{ readonly theaterId: string; readonly count: number; readonly slotIndex?: number }>,
  aspect = 1.8,
): readonly FleetMapZoneLayout[] {
  if (zones.length === 0) return [];
  const safeAspect = Number.isFinite(aspect) && aspect > 0.2 ? Math.min(aspect, 6) : 1.8;
  const width = 100 * safeAspect;
  const total = zones.reduce((sum, zone) => sum + Math.max(1, zone.count), 0) || 1;
  const circles = zones.map((zone, index) => {
    // 슬롯은 Theater 자신의 고정 번호로 고른다 — 입력 순서로 고르면 정렬이 바뀔 때마다 구역이
    // 서로 자리를 맞바꾼다. 판 위의 자리는 패널 상태가 아니라 Theater 정체성에 묶여야 한다
    // (구역 색을 theaterIndex로 고정한 것과 같은 이유).
    const slot = FLEET_ZONE_SLOTS[(zone.slotIndex ?? index) % FLEET_ZONE_SLOTS.length]!;
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
          const need = a.r + b.r + FLEET_ZONE_GAP;
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
        circle.y = Math.min(100 - circle.r - 1, Math.max(circle.r + FLEET_ZONE_LABEL_HEADROOM, circle.y));
      }
      if (!moved) break;
    }
    const overlapped = circles.some((a, i) => circles.some((b, j) => j > i
      && Math.hypot(b.x - a.x, b.y - a.y) < a.r + b.r + FLEET_ZONE_GAP - 0.5));
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

export function resolveFleetMapMarkerLayout(
  operations: ReadonlyArray<Pick<OperationNode, "id"> & { readonly geometry: OperationGeometry | null }>,
  /** 구역 중앙에 Theater 표석이 서는 배치인지 — 표석이 없는 단일 함대(판 전체)는 비워 둘 띠가 없다. */
  reserveLabelBand = false,
): readonly FleetMapMarkerLayout[] {
  const { minX, maxX, minY, maxY, degenerate } = resolveFleetMapBounds(operations);
  const points = new Map<string, { x: number; y: number }>();
  for (const operation of operations) {
    if (!degenerate && operation.geometry) {
      const centerX = operation.geometry.x + operation.geometry.width / 2;
      const centerY = operation.geometry.y + operation.geometry.height / 2;
      const x = 8 + ((centerX - minX) / (maxX - minX)) * 84;
      const y = 10 + ((centerY - minY) / (maxY - minY)) * 76;
      points.set(operation.id, { x, y });
      continue;
    }
    const hashIndex = hashFleetMapKey(operation.id);
    const angle = hashIndex * GOLDEN_ANGLE;
    const radius = Math.sqrt((hashIndex * GOLDEN_FRACTION) % 1);
    points.set(operation.id, {
      x: clampPercent(50 + Math.cos(angle) * radius * 42),
      y: clampPercent(48 + Math.sin(angle) * radius * 38),
    });
  }

  relaxFleetMapMarkers(points, reserveLabelBand);
  return operations.map((operation) => ({
    operationId: operation.id,
    x: points.get(operation.id)!.x,
    y: points.get(operation.id)!.y,
  }));
}

// 마커 배치가 쓰는 정규화 기준 상자와 그 퇴화 판정. 퇴화(점 3개 미만 또는 거의 한 줄)면
// 결정적 해시 산포로 떨어지므로 상자는 의미가 없다.
function resolveFleetMapBounds(
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
    degenerate = majorSpread === 0 || minorSpread / majorSpread < MAP_COLLINEAR_RATIO;
  }
  return { minX, maxX, minY, maxY, degenerate };
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
function placeFleetMapPoint(
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
function relaxFleetMapMarkers(
  points: Map<string, { x: number; y: number }>,
  reserveLabelBand = false,
): void {
  const entries = [...points.values()]
    .sort((left, right) => left.x - right.x || left.y - right.y);
  if (entries.length === 0) return;
  // 초기 배치가 이미 띠를 밟고 있을 수 있다 — 이완 전에 제자리에서 한 번 투영해 둔다.
  for (const point of entries) placeFleetMapPoint(point, point.x, point.y, reserveLabelBand);
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
        if (distance < MAP_MIN_DISTANCE_PCT) {
          moved = true;
          if (distance > 1e-6) {
            const push = (MAP_MIN_DISTANCE_PCT - distance) / 2;
            const ux = dx / distance;
            const uy = dy / distance;
            placeFleetMapPoint(a, a.x - ux * push, a.y - uy * push, reserveLabelBand);
            placeFleetMapPoint(b, b.x + ux * push, b.y + uy * push, reserveLabelBand);
          } else {
            // 완전 일치는 결정적 방향으로만 분리한다 — 무작위 방향이면 렌더마다 흔들린다.
            placeFleetMapPoint(a, a.x - MAP_MIN_DISTANCE_PCT / 2, a.y, reserveLabelBand);
            placeFleetMapPoint(b, b.x + MAP_MIN_DISTANCE_PCT / 2, b.y, reserveLabelBand);
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
        placeFleetMapPoint(a, a.x, a.y - direction * rowPush, reserveLabelBand);
        placeFleetMapPoint(b, b.x, b.y + direction * rowPush, reserveLabelBand);
        if (Math.abs(b.y - a.y) > beforeGap + 1e-6) continue;
        const columnPush = (MAP_LABEL_MIN_DX_PCT - Math.abs(dx)) / 2;
        const columnDirection = dx >= 0 ? 1 : -1;
        placeFleetMapPoint(a, a.x - columnDirection * columnPush, a.y, reserveLabelBand);
        placeFleetMapPoint(b, b.x + columnDirection * columnPush, b.y, reserveLabelBand);
      }
    }
    if (!moved) return;
  }
}

function clampPercent(value: number): number {
  return Math.min(96, Math.max(4, value));
}

export function hashFleetMapKey(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (Math.imul(hash, 31) + key.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

// 점의 유영 진폭·주기 — 실행 중은 넓고 빠르게, 나머지 상태는 그 절반 이하로 좁고 느리게 돈다.
// 정지한 점은 판을 정물로 만들지만, 모든 점이 같은 폭으로 흔들리면 "실행 중"이 가진 움직임의
// 의미가 사라진다. 진폭 차이가 상태 위계를 그대로 옮긴다.
const FLEET_MAP_DRIFT_CALM_AMPLITUDE = 0.42;
const FLEET_MAP_DRIFT_CALM_PERIOD = 1.55;

export function resolveFleetMapDriftStyle(operationId: string, active: boolean): CSSProperties {
  // id 해시 기반 결정적 주입 — 렌더마다 흔들리면 지도가 아니다. 주기는 초 리터럴이 아니라
  // --duration-slow 배수라 테마 모션 스케일을 따라간다.
  const hash = hashFleetMapKey(operationId);
  const amplitude = active ? 1 : FLEET_MAP_DRIFT_CALM_AMPLITUDE;
  const period = (30.6 + (hash % 7) * 5) * (active ? 1 : FLEET_MAP_DRIFT_CALM_PERIOD);
  const offset = (shift: number, span: number) => `${((((hash >> shift) % span) - (span - 1) / 2) * amplitude).toFixed(1)}px`;
  return {
    "--fleet-drift-mult": period.toFixed(1),
    "--fleet-drift-x1": offset(2, 29),
    "--fleet-drift-y1": offset(4, 23),
    "--fleet-drift-x2": offset(6, 29),
    "--fleet-drift-y2": offset(8, 23),
  } as CSSProperties;
}
