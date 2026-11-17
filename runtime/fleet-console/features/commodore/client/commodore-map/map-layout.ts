import { MAP_BRANCH_ORDER, type MapBranchKey, type MapGraph, type MapNodeKind } from "./map-graph.js";

/**
 * 시드 고정 갈래 물리 — d3 없이 자체 구현. 갈래마다 구역을 주고, 정착하면 멈춘다(계속 흔들지 않음).
 * 3D 확장용 z는 작게 둔다 — 정면에서 보면 안 A와 같은 지도다. `layoutMapGraph`는 동기라
 * 렌더러는 그린 뒤 시뮬레이션을 돌리지 않는다. 같은 입력·시드는 항상 같은 좌표다.
 */

export interface MapVec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface MapLayout {
  /** 노드 id → 배치 좌표(반지름 ≈1.6 안). */
  readonly positions: ReadonlyMap<string, MapVec3>;
  /** 맞춤 보기·클리핑이 읽는 전체 bounds. */
  readonly bounds: { readonly minX: number; readonly maxX: number; readonly minY: number; readonly maxY: number };
}

/** 그리기 크기 힌트(상대 단위) — 고르기 반경·라벨 자리가 함께 읽는다. */
export function mapNodeSize(kind: MapNodeKind): number {
  switch (kind) {
    case "core": return 1;
    case "branch": case "intel-hub": return 0.55;
    case "description": return 0.5;
    case "topic": case "source": case "objective": return 0.4;
    case "intel-overflow": return 0.38;
    case "intel": case "memory": return 0.3;
  }
}

const LIMB_ANGLE: Record<MapBranchKey, number> = (() => {
  const entries = MAP_BRANCH_ORDER.map((branch, index) => {
    // 위에서 시작해 시계 방향으로 여섯 구역.
    const angle = (-Math.PI / 2) + (index * Math.PI * 2) / MAP_BRANCH_ORDER.length;
    return [branch, angle] as const;
  });
  return Object.fromEntries(entries) as Record<MapBranchKey, number>;
})();

const HUB_RADIUS = 1;
const CHILD_MIN = 0.45;
const CHILD_MAX = 0.8;
const WEDGE = 0.38;
/** 정면 지도와 같아 보이는 깊이 — 반지름의 ±8%. */
const Z_SPREAD = 0.08;

/** mulberry32 — 시드 고정 난수. */
function rng32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const KIND_DEPTH: Record<MapNodeKind, number> = {
  core: 0, description: 1, "intel-hub": 1, branch: 1,
  "intel-overflow": 2, source: 2, topic: 2,
  intel: 3, memory: 3, objective: 2,
};

export function layoutMapGraph(graph: MapGraph, options: { readonly seed?: number } = {}): MapLayout {
  const rand = rng32(options.seed ?? 20261117);
  const placed = new Map<string, { x: number; y: number; z: number }>();

  placed.set("core", { x: 0, y: 0, z: 0 });
  const limbOf = (id: string): MapBranchKey | null => graph.byId.get(id)?.branch ?? null;

  // 초기 배치 — 허브는 구역 각도 위, 자식은 그 쐐기 안에 뿌린다.
  for (const node of graph.nodes) {
    if (node.id === "core") continue;
    const limb = limbOf(node.id) ?? "theater";
    const angle = LIMB_ANGLE[limb] ?? 0;
    const depth = KIND_DEPTH[node.kind];
    if (depth <= 1) {
      placed.set(node.id, {
        x: HUB_RADIUS * Math.cos(angle),
        y: HUB_RADIUS * Math.sin(angle),
        z: (rand() - 0.5) * 2 * Z_SPREAD,
      });
    } else {
      const jitter = (rand() - 0.5) * 2 * WEDGE;
      const radius = CHILD_MIN + rand() * (CHILD_MAX - CHILD_MIN) + (depth - 2) * 0.35;
      const a = angle + jitter;
      placed.set(node.id, {
        x: radius * Math.cos(a) + HUB_RADIUS * Math.cos(angle) * 0.55,
        y: radius * Math.sin(a) + HUB_RADIUS * Math.sin(angle) * 0.55,
        z: (rand() - 0.5) * 2 * Z_SPREAD * radius,
      });
    }
  }

  // 정착 — 고정 횟수만 밀고 끝나며, 난수는 쓰지 않아 같은 초기 배치는 같은 결과다.
  const ids = graph.nodes.map((node) => node.id);
  const order = new Map(ids.map((id, index) => [id, index] as const));
  for (let step = 0; step < 60; step += 1) {
    const cool = 1 - step / 60;
    const sorted = [...graph.edges].sort((a, b) =>
      (order.get(a.from) ?? 0) - (order.get(b.from) ?? 0) || (a.to < b.to ? -1 : 1),
    );
    for (const edge of sorted) {
      if (edge.kind !== "tree") continue;
      const a = placed.get(edge.from);
      const b = placed.get(edge.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 1e-6;
      const want = edge.from === "core" ? HUB_RADIUS : 0.42;
      const pull = ((dist - want) / dist) * 0.06 * cool;
      if (edge.to !== "core") { b.x -= dx * pull; b.y -= dy * pull; }
    }
    for (let i = 0; i < ids.length; i += 1) {
      const a = placed.get(ids[i]!)!;
      for (let j = i + 1; j < ids.length; j += 1) {
        const b = placed.get(ids[j]!)!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 1e-6;
        const min = (mapNodeSize(graph.byId.get(ids[i]!)?.kind ?? "memory") + mapNodeSize(graph.byId.get(ids[j]!)?.kind ?? "memory")) * 0.22;
        if (dist >= min) continue;
        const push = ((min - dist) / dist) * 0.12 * cool;
        const ax = a.x - dx * push;
        const ay = a.y - dy * push;
        if (ids[i] !== "core") { a.x = ax; a.y = ay; }
        if (ids[j] !== "core") { b.x += dx * push; b.y += dy * push; }
      }
    }
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const positions = new Map<string, MapVec3>();
  for (const [id, point] of placed) {
    const frozen = Object.freeze({ x: point.x, y: point.y, z: point.z });
    positions.set(id, frozen);
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  return { positions, bounds: { minX, maxX, minY, maxY } };
}
