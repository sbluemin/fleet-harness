import type { OperationGeometry } from "@fleet-console/sdk/operations";

// Operation 트리(parentId)를 캔버스 간선으로 그리기 위한 순수 기하 계산.
// React/DOM에 비의존 — 단위 테스트 대상(operation-edges.test.ts).

export interface EdgeOperationInput {
  readonly id: string;
  readonly parentId: string | null;
  readonly geometry: OperationGeometry;
}

export interface EdgePoint {
  readonly x: number;
  readonly y: number;
}

export interface OperationEdge {
  // `${parentId}->${childId}` — React key/식별용 안정 키.
  readonly id: string;
  readonly parentId: string;
  readonly childId: string;
  // 부모(기함) 경계 앵커 — 신호 전류의 출발점.
  readonly from: EdgePoint;
  // 자식(예하) 경계 앵커 — 신호 전류의 도착점(made-fast).
  readonly to: EdgePoint;
  // SVG path 'd'. from→to 진행 방향에 부모→자식 위계가 보존된다(흐름 애니메이션 방향의 근거).
  readonly path: string;
}

// 예삭(tether)의 처짐 — 두 앵커 거리의 이 비율만큼 수직으로 부풀린다. 과도한 휘어짐 상한.
const BOW_RATIO = 0.16;
const BOW_MAX = 56;
// 중심이 거의 일치하는 박스(0 division)를 단락하기 위한 최소 분모.
const MIN_AXIS = 0.0001;

// 부모-자식 쌍 각각에 대해 간선을 만든다. 부모·자식이 모두 visibleIds에 있을 때만(둘 다 화면에 떠 있을 때만) 그린다.
export function computeOperationEdges(
  operations: readonly EdgeOperationInput[],
  visibleIds: ReadonlySet<string>,
): readonly OperationEdge[] {
  const byId = new Map<string, EdgeOperationInput>();
  for (const operation of operations) byId.set(operation.id, operation);

  const edges: OperationEdge[] = [];
  for (const operation of operations) {
    if (operation.parentId === null) continue;
    if (!visibleIds.has(operation.id) || !visibleIds.has(operation.parentId)) continue;
    const parent = byId.get(operation.parentId);
    if (!parent) continue;
    const from = boxAnchor(parent.geometry, centerOf(operation.geometry));
    const to = boxAnchor(operation.geometry, centerOf(parent.geometry));
    edges.push({
      id: `${operation.parentId}->${operation.id}`,
      parentId: operation.parentId,
      childId: operation.id,
      from,
      to,
      path: edgePath(from, to),
    });
  }
  return edges;
}

function centerOf(geometry: OperationGeometry): EdgePoint {
  return { x: geometry.x + geometry.width / 2, y: geometry.y + geometry.height / 2 };
}

// 박스 중심에서 target 방향으로 쏜 광선이 박스 경계와 만나는 지점(ray-box intersection).
// 앵커를 패널 테두리에 붙여 간선이 패널 가장자리에서 출발/도착하게 한다.
function boxAnchor(geometry: OperationGeometry, target: EdgePoint): EdgePoint {
  const cx = geometry.x + geometry.width / 2;
  const cy = geometry.y + geometry.height / 2;
  const dx = target.x - cx;
  const dy = target.y - cy;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  // 중심이 일치하면 경계 방향을 정할 수 없으므로 중심을 반환한다(degenerate, 간선 길이 0).
  if (absDx < MIN_AXIS && absDy < MIN_AXIS) return { x: cx, y: cy };
  const tx = absDx < MIN_AXIS ? Infinity : geometry.width / 2 / absDx;
  const ty = absDy < MIN_AXIS ? Infinity : geometry.height / 2 / absDy;
  const t = Math.min(tx, ty);
  return { x: cx + dx * t, y: cy + dy * t };
}

// from→to를 진행 방향의 좌측 수직으로 살짝 부풀린 2차 베지에. 곡선이라 인접 간선이 겹쳐도 부채처럼 갈라진다.
function edgePath(from: EdgePoint, to: EdgePoint): string {
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const bow = Math.min(length * BOW_RATIO, BOW_MAX);
  // 진행 방향(dx,dy)의 좌측 수직 단위벡터(-dy,dx)/len 만큼 제어점을 민다.
  const controlX = midX + (-dy / length) * bow;
  const controlY = midY + (dx / length) * bow;
  return `M ${round(from.x)} ${round(from.y)} Q ${round(controlX)} ${round(controlY)} ${round(to.x)} ${round(to.y)}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
