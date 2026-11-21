import type { MapBranchKey, MapGraph, MapNodeKind } from "./map-graph.js";
import { rng32 } from "./map-random.js";

/**
 * 시드 고정 갈래 물리 — d3 없이 자체 구현. 시안(안 D)의 힘 배치 비율을 따른다.
 * 갈래마다 시안 각도(ANG)에 구역을 주고, 정착하면 멈춘다(계속 흔들지 않음).
 * 3D 확장용 z는 작게 둔다 — 정면에서 보면 안 A와 같은 지도다(깊이는 렌더러 몫).
 * `layoutMapGraph`는 동기라 렌더러는 그린 뒤 시뮬레이션을 돌리지 않는다.
 * 같은 입력·시드는 항상 같은 좌표다.
 */

export interface MapVec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface MapLayout {
  /** 노드 id → 배치 좌표(반경 ≈1.6 안). 시안 단위를 280으로 나눈 값이다. */
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

/** 시안 갈래 각도(도, 0° = +x, y는 아래가 +) — 시안 ANG 그대로 둔다. */
const MOCKUP_ANGLE: Record<MapBranchKey, number> = {
  description: -90,
  theater: -30,
  lessons: 30,
  crew: 90,
  person: 150,
  intel: 210,
};

const DEG = Math.PI / 180;
const limbOf = (branch: MapBranchKey): number => (MOCKUP_ANGLE[branch] ?? 0) * DEG;

/** 시안 단위 → 배치 단위. 렌더러가 단위를 바꾸지 않아도 되게 시안 비율 그대로 둔다. */
const MOCKUP_UNIT = 280;

/** 시안 질량 — 같은 종류끼리 뭉치는 정도. */
function mockupMass(kind: MapNodeKind): number {
  switch (kind) {
    case "core": return 3;
    case "description": case "intel-hub": case "branch": return 2;
    case "topic": return 1.2;
    case "objective": return 1.5;
    case "memory": case "intel": case "intel-overflow": case "source": return 1;
  }
}

type SpringSpec = readonly [len: number, k: number];
/** 시안 용수철 [자연 길이, 세기] — 종류별 가지 길이. */
const MOCKUP_SPRING: Record<string, SpringSpec> = {
  trunk: [104, 0.09],
  branch: [62, 0.07],
  twig: [36, 0.09],
  intel: [46, 0.07],
  link: [150, 0.006],
  linkTarget: [120, 0.008],
};

function springOf(fromKind: MapNodeKind, toKind: MapNodeKind, edgeKind: string): SpringSpec {
  if (edgeKind === "link") return MOCKUP_SPRING.link!;
  if (edgeKind === "objective" || edgeKind === "source") return MOCKUP_SPRING.linkTarget!;
  if (fromKind === "core") return MOCKUP_SPRING.trunk!;
  if (toKind === "topic") return MOCKUP_SPRING.branch!;
  if (toKind === "memory") return MOCKUP_SPRING.twig!;
  return MOCKUP_SPRING.intel!;
}

/** 시안 앵커 [구역 각도, 반경, 당김] — 갈래마다 구역을 잡는다. */
function anchorOf(kind: MapNodeKind, branch: MapBranchKey | null): readonly [number, number, number] | null {
  const angle = (key: MapBranchKey): number => limbOf(key);
  switch (kind) {
    case "core": return null;
    case "description": return [angle("description"), 104, 0.08];
    case "intel-hub": return [angle("intel"), 110, 0.08];
    case "branch": return branch === null ? null : [angle(branch), 112, 0.08];
    case "topic": return branch === null ? null : [angle(branch), 200, 0.01];
    case "memory": return branch === null ? null : [angle(branch), 290, 0.006];
    case "intel": case "intel-overflow": return [angle("intel"), 190, 0.012];
    case "source": return [angle("intel"), 190, 0.012];
    case "objective": return null;
  }
}

/** 지름 ≈ 무대 폭 35~40%까지 퍼지는 시안 힘 배치. */
export function layoutMapGraph(graph: MapGraph, options: { readonly seed?: number } = {}): MapLayout {
  const rand = rng32(options.seed ?? 20261117);
  interface Body { x: number; y: number; vx: number; vy: number; fx: number; fy: number }
  const bodies = new Map<string, Body>();
  const placed = new Map<string, { x: number; y: number; z: number }>();

  for (const node of graph.nodes) {
    const body: Body = { x: 0, y: 0, vx: 0, vy: 0, fx: 0, fy: 0 };
    if (node.id !== "core") {
      const anchor = anchorOf(node.kind, node.branch);
      const baseX = anchor ? Math.cos(anchor[0]) * anchor[1] : 0;
      const baseY = anchor ? Math.sin(anchor[0]) * anchor[1] : 0;
      body.x = baseX + (rand() - 0.5) * 30;
      body.y = baseY + (rand() - 0.5) * 30;
    }
    bodies.set(node.id, body);
    // z는 작게 둔다 — 정면에서 보면 안 A와 같은 지도다(깊이감은 렌더러 몫).
    placed.set(node.id, { x: 0, y: 0, z: (rand() - 0.5) * 2 * 0.08 });
  }

  const ids = graph.nodes.map((node) => node.id);
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const massOf = (id: string): number => mockupMass(byId.get(id)?.kind ?? "memory");

  // 시안 simTick — 반발(110·m²/d², 219px 밖은 무시) + 용수철 + 앵커 당김.
  // 감쇠 0.58, 속도 상한 12, 320회, alpha 1→0.2.
  for (let step = 0; step < 320; step += 1) {
    const alpha = 1 - step / 400;
    for (const body of bodies.values()) { body.fx = 0; body.fy = 0; }
    for (let i = 0; i < ids.length; i += 1) {
      const a = bodies.get(ids[i]!)!;
      const ma = massOf(ids[i]!);
      for (let j = i + 1; j < ids.length; j += 1) {
        const b = bodies.get(ids[j]!)!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 > 48000) continue;
        if (d2 < 1) {
          const ang = rand() * Math.PI * 2;
          dx = Math.cos(ang); dy = Math.sin(ang); d2 = 1;
        }
        const f = (110 * ma * massOf(ids[j]!)) / d2;
        const dist = Math.sqrt(d2);
        const fx = (dx / dist) * f;
        const fy = (dy / dist) * f;
        a.fx -= fx; a.fy -= fy; b.fx += fx; b.fy += fy;
      }
    }
    for (const edge of graph.edges) {
      const a = bodies.get(edge.from);
      const b = bodies.get(edge.to);
      const an = byId.get(edge.from);
      const bn = byId.get(edge.to);
      if (!a || !b || !an || !bn) continue;
      const [len, k] = springOf(an.kind, bn.kind, edge.kind);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 1e-6;
      const f = (dist - len) * k;
      const fx = (dx / dist) * f;
      const fy = (dy / dist) * f;
      a.fx += fx; a.fy += fy; b.fx -= fx; b.fy -= fy;
    }
    for (const [id, body] of bodies) {
      const node = byId.get(id);
      if (!node || node.id === "core") continue;
      const anchor = anchorOf(node.kind, node.branch);
      if (anchor) {
        const ax = Math.cos(anchor[0]) * anchor[1];
        const ay = Math.sin(anchor[0]) * anchor[1];
        body.fx += (ax - body.x) * anchor[2];
        body.fy += (ay - body.y) * anchor[2];
      } else if (node.kind === "objective") {
        body.fx -= body.x * 0.002;
        body.fy -= body.y * 0.002;
      }
    }
    for (const [id, body] of bodies) {
      if (id === "core") { body.x = 0; body.y = 0; body.vx = 0; body.vy = 0; continue; }
      body.vx = (body.vx + body.fx * alpha) * 0.58;
      body.vy = (body.vy + body.fy * alpha) * 0.58;
      const speed = Math.hypot(body.vx, body.vy);
      if (speed > 12) { body.vx *= 12 / speed; body.vy *= 12 / speed; }
      body.x += body.vx;
      body.y += body.vy;
    }
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const positions = new Map<string, MapVec3>();
  for (const [id, body] of bodies) {
    const scatter = placed.get(id)!;
    const frozen = Object.freeze({ x: body.x / MOCKUP_UNIT, y: body.y / MOCKUP_UNIT, z: scatter.z });
    positions.set(id, frozen);
    if (frozen.x < minX) minX = frozen.x;
    if (frozen.x > maxX) maxX = frozen.x;
    if (frozen.y < minY) minY = frozen.y;
    if (frozen.y > maxY) maxY = frozen.y;
  }
  return { positions, bounds: { minX, maxX, minY, maxY } };
}
