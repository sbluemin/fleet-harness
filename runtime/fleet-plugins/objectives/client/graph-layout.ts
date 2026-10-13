import type { ObjectiveMission } from "../server/types.js";

export interface Point { x: number; y: number }
export interface Rect extends Point { w: number; h: number }
export interface GraphEdge { from: string | null; to: string; d: string }
export const intersects = (a: Rect, b: Rect, pad = 0) => a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;

/** 노드 둘레에서 지나가는 선이 비켜야 하는 여유. */
const CLEAR = 3;
/** 이름 칸의 가장 좁은 폭 — 레인이 많아 이보다 좁아지면 레인 간격을 줄이고, 그래도 모자라면 캔버스를 넓힌다. */
const MIN_LABEL = 120;
const MIN_LANE = 16;
/** 줄 간격 — 노드 위의 기록 표식(r+6)과 윗줄 노드 아래의 담당 표식(r+10)이 같은 레인에서 겹치지 않는 최소에 맞춘다. 시각 검수가 조정하는 값. */
export const ROW_H = { narrow: 52, wide: 56 } as const;

interface Segment { a: Point; b: Point }
interface Vertical { x: number; y1: number; y2: number }
interface Placed { from: string | null; to: string; points: Point[]; verticals: Vertical[]; lane: number }
/** 가지를 치기 전에 제 레인을 따라 내려가는(합친 뒤 내려오는) 길이 후보 — 반 줄 단위. 옆 레인 노드를 스치지 않을 때까지 늦춘다. */
const OFFSETS = [0, .5, 1, 1.5, 2, 2.5, 3];
/** 레인 배정 캐시 — 배정은 선행 모양·폭 단계·레인 간격에만 달려, 레일을 끄는 동안 바뀌는 폭은 담아 둔 배정을 다시 쓴다. */
const assigned = new Map<string, { lane: Map<string, number>; placed: Placed[]; lanes: number }>();
const ASSIGNED_LIMIT = 32;

const round = (n: number) => Math.round(n * 10) / 10;
function distance(p: Point, s: Segment) {
  const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y, len = dx * dx + dy * dy;
  const k = len ? Math.max(0, Math.min(1, ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - (s.a.x + k * dx), p.y - (s.a.y + k * dy));
}
const segments = (points: readonly Point[]) => points.slice(1).map((b, i) => ({ a: points[i]!, b }));
/** 꺾임만 둥글린 꺾은선 — 같은 방향으로 이어지는 점은 곧은 선으로 지난다. */
function roundedPath(points: readonly Point[], radius: number) {
  let d = `M${round(points[0]!.x)},${round(points[0]!.y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p0 = points[i - 1]!, p1 = points[i]!, p2 = points[i + 1]!;
    const d1 = Math.hypot(p1.x - p0.x, p1.y - p0.y), d2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (Math.abs((p1.x - p0.x) * (p2.y - p1.y) - (p1.y - p0.y) * (p2.x - p1.x)) < 1e-6 || !d1 || !d2) { d += ` L${round(p1.x)},${round(p1.y)}`; continue; }
    const r = Math.min(radius, d1 / 2, d2 / 2);
    d += ` L${round(p1.x - (p1.x - p0.x) / d1 * r)},${round(p1.y - (p1.y - p0.y) / d1 * r)} Q${round(p1.x)},${round(p1.y)} ${round(p1.x + (p2.x - p1.x) / d2 * r)},${round(p1.y + (p2.y - p1.y) / d2 * r)}`;
  }
  const last = points.at(-1)!;
  return `${d} L${round(last.x)},${round(last.y)}`;
}

/**
 * 승인 시안 C(줄기-가지)의 세로 배치. 한 줄에 임무 하나를 편성 순서로 놓고(선행이 뒤에 있으면 그 뒤로 내린다), 병렬은 레인으로 옆에 선다.
 * 간선은 레인을 따라 곧게 내려가다 갈라지고 합칠 때만 45° 가지를 친다. 지나가는 선이 있는 레인 자리에는 노드를 두지 않고,
 * 다른 노드를 스치는 선은 바깥 레인으로 돌린다. 이름은 모든 레인 오른쪽의 같은 칸에 줄마다 놓여 노드·선·다른 이름과 겹치지 않는다.
 */
export function graphLayout(missions: readonly ObjectiveMission[], width: number, wide: boolean) {
  const g = wide ? { r: 12, rootR: 11, rowH: ROW_H.wide, lane: 22, pad: 22, llh: 16 } : { r: 11, rootR: 10, rowH: ROW_H.narrow, lane: 20, pad: 16, llh: 14 };
  // 줄 순서 — 편성 순서를 지키되, 선행은 늘 위 줄에 온다(위에서 아래로만 흐른다).
  const ids = new Set(missions.map(m => m.id)), order: ObjectiveMission[] = [], seen = new Set<string>();
  const parentsOf = (m: ObjectiveMission) => [...new Set(m.prerequisites)].filter(id => ids.has(id) && id !== m.id);
  while (order.length < missions.length) {
    const next = missions.find(m => !seen.has(m.id) && parentsOf(m).every(id => seen.has(id))) ?? missions.find(m => !seen.has(m.id))!;
    order.push(next); seen.add(next.id);
  }
  const rowY = (row: number) => g.rowH / 2 + row * g.rowH;
  const row = new Map(order.map((m, i) => [m.id, i + 1]));
  const shape = order.map(m => `${m.id}:${parentsOf(m).join(",")}`).join(";");
  const assign = (step: number) => {
    const lx = (l: number) => g.pad + g.r + l * step;
    const key = `${wide}\u0003${step}\u0003${shape}`, hit = assigned.get(key);
    if (hit) { assigned.delete(key); assigned.set(key, hit); return { ...hit, lx }; }
    const lane = new Map<string, number>();
    const nodes: { id: string | null; at: Point; r: number }[] = [{ id: null, at: { x: lx(0), y: rowY(0) }, r: g.rootR }];
    const placed: Placed[] = [];
    const at = (id: string | null) => id ? { x: lx(lane.get(id)!), y: rowY(row.get(id)!) } : { x: lx(0), y: rowY(0) };
    // 부모 → (제 레인을 s만큼 내려가) 45° 가지 → 이동 레인 t → 45° 가지 → (자식 레인을 e만큼 내려와) 자식. 줄 사이에 안 들어가면 null.
    const route = (p: Point, c: Point, t: number, s: number, e: number) => {
      const xt = lx(t), ys = p.y + s, ye = c.y - e, y1 = ys + Math.abs(xt - p.x), y2 = ye - Math.abs(c.x - xt);
      if (y1 > y2 + .01) return null;
      const points = [p];
      if (xt !== p.x) { if (s) points.push({ x: p.x, y: ys }); points.push({ x: xt, y: y1 }); }
      if (xt !== c.x) { points.push({ x: xt, y: y2 }); if (e) points.push({ x: c.x, y: ye }); }
      points.push(c);
      return points;
    };
    const verticalsOf = (points: readonly Point[]) => segments(points).filter(q => Math.abs(q.a.x - q.b.x) < .01 && q.b.y - q.a.y > .5).map(q => ({ x: q.a.x, y1: q.a.y, y2: q.b.y }));
    const clear = (points: readonly Point[], ends: readonly (string | null)[]) => {
      const segs = segments(points);
      return nodes.every(n => ends.includes(n.id) || segs.every(s => distance(n.at, s) >= n.r + CLEAR));
    };
    // 같은 레인을 따라 겹쳐 내려가는 선은 같은 부모의 줄기이거나 같은 자식으로 합치는 가지일 때만 허용한다.
    const free = (verticals: readonly Vertical[], from: string | null, to: string, extra: readonly Placed[]) =>
      [...placed, ...extra].every(e => e.from === from || e.to === to || e.verticals.every(o => verticals.every(v => Math.abs(o.x - v.x) > .01 || o.y2 <= v.y1 + 1 || o.y1 >= v.y2 - 1)));
    for (const m of order) {
      const i = row.get(m.id)!, parents = parentsOf(m), sources: (string | null)[] = parents.length ? parents : [null];
      const limit = Math.max(0, ...lane.values()) + sources.length + 2;
      let best: { cost: number; l: number; edges: Placed[] } | null = null;
      const merge = sources.length > 1, stem = Math.min(...sources.map(from => from ? lane.get(from)! : 0));
      // 비용 — 노드 레인(줄기 쪽을 선호), 선이 옆으로 건넌 레인 수, 꺾임. 한 부모에서 나갔다 되돌아오는 활꼴과 합류가 줄기를 벗어나는 것은 무겁게 친다.
      for (let l = 0; l <= limit && (!best || l * 1.5 < best.cost); l++) {
        const c = { x: lx(l), y: rowY(i) }, edges: Placed[] = [];
        let cost = l * 1.5 + (merge ? Math.max(0, l - stem) * 2 : 0);
        for (const from of sources) {
          const p = at(from), lp = from ? lane.get(from)! : 0, base = Math.max(lp, l);
          let chosen: { cost: number; edge: Placed } | null = null;
          for (let t = base; t <= limit + 1 && !chosen; t++) {
            // 같은 이동 레인에서는 가지를 덜 늦춘 길부터 본다 — 늦춤은 바깥 레인으로 도는 것보다 가볍다.
            const tries: { points: Point[]; delay: number }[] = [];
            for (const a of t === lp ? [0] : OFFSETS) for (const b of t === l ? [0] : OFFSETS) {
              const points = route(p, c, t, a * g.rowH, b * g.rowH);
              if (points) tries.push({ points, delay: a + b });
            }
            // 바로 아래 줄로 두 레인까지 건너는데 두 가지가 줄 사이에 안 들어갈 때만 곧은 사선 하나로 잇는다.
            if (!tries.length && t === base && Math.abs(lp - l) <= 2) tries.push({ points: [p, c], delay: 2 });
            tries.sort((x, y) => x.delay - y.delay);
            for (const { points, delay } of tries) {
              if (!clear(points, [from, m.id])) continue;
              const verticals = verticalsOf(points);
              if (!free(verticals, from, m.id, edges)) continue;
              const bow = !merge && t !== l ? 2 : 0;
              chosen = { cost: (t - lp) + (t - l) + (points.length - 2) * .5 + delay * .25 + bow, edge: { from, to: m.id, points, verticals, lane: t } };
              break;
            }
          }
          if (!chosen) { cost = Infinity; break; }
          cost += chosen.cost; edges.push(chosen.edge);
        }
        if (cost < (best?.cost ?? Infinity)) best = { cost, l, edges };
      }
      // 맞는 레인이 없으면(바깥 레인은 늘 비어 있어 생기지 않아야 한다) 바깥 레인에 곧은 선으로 둔다.
      const l = best?.l ?? limit + 1;
      lane.set(m.id, l);
      nodes.push({ id: m.id, at: at(m.id), r: g.r });
      placed.push(...(best?.edges ?? sources.map(from => ({ from, to: m.id, points: [at(from), at(m.id)], verticals: [], lane: l }))));
    }
    // 이름 칸은 노드뿐 아니라 바깥으로 돈 선이 쓴 레인보다도 오른쪽에 선다.
    const result = { lane, placed, lanes: Math.max(0, ...lane.values(), ...placed.map(e => e.lane)) };
    if (assigned.size >= ASSIGNED_LIMIT) assigned.delete(assigned.keys().next().value!);
    assigned.set(key, result);
    return { ...result, lx };
  };
  // 레인이 많아 이름 칸이 MIN_LABEL 보다 좁아지면 간격을 줄여 다시 배정한다 — 가지는 45°를 지키고 겹침 판정도 줄인 간격으로 다시 한다.
  let run = assign(g.lane), step = g.lane;
  const room = width - 2 * g.pad - 2 * g.r - 14 - MIN_LABEL;
  if (run.lanes && room / run.lanes < g.lane) { step = Math.max(MIN_LANE, Math.floor(room / run.lanes)); run = assign(step); }
  const pos = new Map<string, Point>([...run.lane].map(([id, l]) => [id, { x: run.lx(l), y: rowY(row.get(id)!) }]));
  const edges: GraphEdge[] = run.placed.map(e => ({ from: e.from, to: e.to, d: roundedPath(e.points, 6) }));
  const labelX = Math.round(run.lx(run.lanes) + g.r + 14);
  return { g, pos, root: { x: run.lx(0), y: rowY(0) }, edges, labelX, width: Math.max(width, labelX + MIN_LABEL + g.pad), height: (order.length + 1) * g.rowH + 4 };
}

export type GraphLayout = ReturnType<typeof graphLayout>;
