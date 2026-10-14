import { missionDepths, type ObjectiveMission } from "../server/types.js";

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

/** 선분이 (여유만큼 넓힌) 사각형을 지나는가 — Liang–Barsky 자르기. */
function crosses(s: Segment, r: Rect, pad: number) {
  const x0 = r.x - pad, x1 = r.x + r.w + pad, y0 = r.y - pad, y1 = r.y + r.h + pad;
  const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, s.a.x - x0], [dx, x1 - s.a.x], [-dy, s.a.y - y0], [dy, y1 - s.a.y]] as const) {
    if (Math.abs(p) < 1e-9) { if (q < 0) return false; continue; }
    const k = q / p;
    if (p < 0) { if (k > t1) return false; if (k > t0) t0 = k; } else { if (k < t0) return false; if (k < t1) t1 = k; }
  }
  return true;
}
/** 곧은 조각 — 가로(flat)면 at 은 y, 세로면 x. */
interface Line { flat: boolean; at: number; lo: number; hi: number }
/** 그은 선 — lo·hi 는 선이 지난 가장 위·아래 레인이다(캔버스 높이와 다음 배정의 바깥 레인을 정한다). */
interface HPlaced { from: string | null; to: string; points: Point[]; lines: Line[]; lo: number; hi: number }
interface HAssigned { lane: Map<string, number>; placed: HPlaced[]; failed: Set<number> }
/** 가로 배치의 레인 배정 캐시 — 배정은 선행 모양·폭 단계·열 간격에만 달린다. */
const hAssigned = new Map<string, HAssigned>();
/** 지휘관(뿌리) 이름 칸의 폭 — 뿌리 위에 한 줄로 선다. */
const ROOT_LABEL_W = 80;
/** 비킬 자리가 없어 열 사이를 넓혀 다시 배정하는 횟수의 상한. */
const WIDEN_LIMIT = 12;
/** 틈 안 줄기의 꺾임(45°) 크기와, 다른 선이 쓰는 줄을 비킬 때의 간격. */
const CHAMFER = 12;
const TRACK = 6;

/**
 * 가로 배치 — 차수(선행 깊이)마다 한 열을 두어 같은 차수의 임무는 같은 x에 선다. 한 열 안의 임무는 편성 순서대로 위에서 아래 레인(줄)에 서고,
 * 간선은 세로 배치와 같은 줄기-가지다: 제 레인을 따라 곧게 오른쪽으로 가다 갈라지고 합칠 때만 45° 가지를 친다. 가지는 열 사이 틈에서만 치고,
 * 한 번의 45°로 틈에 못 들어가는 먼 레인은 45°로 갈라져 틈 안을 곧게 내려간(올라간) 뒤 45°로 든다.
 * 이름은 노드 아래(담당 표식 밑)에서 오른쪽으로 열 안에 서고, 선은 노드·이름·다른 선의 곧은 조각을 비켜 간다 — 비킬 자리가 없으면 그 열 앞을 넓혀 다시 배정한다.
 */
export function horizontalLayout(missions: readonly ObjectiveMission[], width: number, wide: boolean) {
  // 이름 칸은 노드 아래 담당 표식(r+10) 밑에서 시작하고, 레인 간격은 그 이름 칸 아래와 아랫레인 노드 위의 기록 표식(r+6)이 닿지 않는 최소에 맞춘다.
  const g = wide ? { r: 12, rootR: 11, laneH: 64, pad: 22, llh: 16, lines: 1, label: 168, labelMax: 260 } : { r: 11, rootR: 10, laneH: 70, pad: 16, llh: 14, lines: 2, label: 112, labelMax: 180 };
  const labelDy = g.r + 11, labelH = Math.max(g.lines * g.llh, 20);
  const depth = missionDepths(missions);
  const ids = new Set(missions.map(m => m.id));
  const parentsOf = (m: ObjectiveMission) => [...new Set(m.prerequisites)].filter(id => ids.has(id) && id !== m.id);
  const index = new Map(missions.map((m, i) => [m.id, i]));
  // 놓는 순서 — 차수 순, 같은 차수는 편성 순. 선은 제 자식의 열까지만 가므로, 열을 놓을 때 왼쪽 열의 노드·이름은 모두 서 있다.
  const order = [...missions].sort((a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0) || index.get(a.id)! - index.get(b.id)!);
  const cols = missions.length ? Math.max(...missions.map(m => depth.get(m.id) ?? 0)) + 1 : 1;
  const shape = order.map(m => `${m.id}:${parentsOf(m).join(",")}`).join(";");
  const rootX = g.pad + g.rootR;
  // 열 간격 — 한 레인을 건너는 45° 가지가 이름 칸 끝과 다음 열 노드 사이에 들어가는 최소. 뿌리 앞은 지휘관 이름 칸을 지나서다.
  const colGap = (labelW: number) => labelW + g.laneH + 2 * CLEAR + 6;
  const rootGap = ROOT_LABEL_W + g.laneH - g.rootR;
  // 넓은 칸은 이름 칸을 늘려 채운다(상한까지). 폭이 매 프레임 바뀌는 동안 다시 배정하지 않도록 8px 단위로 끊는다.
  const natural = rootX + rootGap + (cols - 1) * colGap(g.label) + g.label - g.r + g.pad;
  const labelW = Math.min(g.labelMax, g.label + Math.max(0, Math.floor((width - natural) / cols / 8) * 8));
  const laneY = (l: number) => l * g.laneH;
  const assign = (gaps: readonly number[]): HAssigned => {
    const xs = gaps.map((_, d) => rootX + gaps.slice(0, d + 1).reduce((a, b) => a + b, 0)), colX = (d: number) => xs[d]!;
    const key = `${wide}\u0003${labelW}\u0003${gaps.join(",")}\u0003${shape}`, hit = hAssigned.get(key);
    if (hit) { hAssigned.delete(key); hAssigned.set(key, hit); return hit; }
    const lane = new Map<string, number>(), failed = new Set<number>(), last = new Map<number, number>();
    const nodes: { id: string | null; at: Point; r: number }[] = [{ id: null, at: { x: rootX, y: 0 }, r: g.rootR }];
    const labels: Rect[] = [{ x: rootX - g.rootR, y: -g.rootR - 18, w: ROOT_LABEL_W, h: 14 }];
    const placed: HPlaced[] = [];
    const at = (id: string | null): Point => id ? { x: colX(depth.get(id) ?? 0), y: laneY(lane.get(id)!) } : { x: rootX, y: 0 };
    const labelOf = (p: Point): Rect => ({ x: p.x - g.r, y: p.y + labelDy, w: labelW, h: labelH });
    // 가지는 열 사이(이름 칸이 끝난 뒤부터 다음 열 노드 앞까지)의 틈에서만 친다 — 노드와 이름은 열 안에만 있으니 틈의 선은 아무것도 덮지 않는다.
    // gs(k)는 k열 앞 틈의 시작(뿌리 틈은 뿌리 가운데), ge(k)는 그 끝이다.
    const gs = (k: number) => k ? colX(k - 1) - g.r + labelW + CLEAR : rootX;
    const ge = (k: number) => colX(k) - g.r - CLEAR - 4;
    const linesOf = (points: readonly Point[]) => segments(points).flatMap(q => {
      const flat = Math.abs(q.a.y - q.b.y) < .01, upright = Math.abs(q.a.x - q.b.x) < .01;
      return flat || upright ? [{ flat, at: flat ? q.a.y : q.a.x, lo: Math.min(flat ? q.a.x : q.a.y, flat ? q.b.x : q.b.y), hi: Math.max(flat ? q.a.x : q.a.y, flat ? q.b.x : q.b.y) }] : [];
    }).filter(q => q.hi - q.lo > .5);
    // 선분마다 둘레 상자로 먼저 거른다 — 노드·이름은 제 열에만 있어 대부분 상자 밖이다.
    const clear = (points: readonly Point[], ends: readonly (string | null)[]) => segments(points).every(s => {
      const x0 = Math.min(s.a.x, s.b.x), x1 = Math.max(s.a.x, s.b.x), y0 = Math.min(s.a.y, s.b.y), y1 = Math.max(s.a.y, s.b.y);
      return nodes.every(n => ends.includes(n.id) || n.at.x < x0 - n.r - CLEAR || n.at.x > x1 + n.r + CLEAR || n.at.y < y0 - n.r - CLEAR || n.at.y > y1 + n.r + CLEAR || distance(n.at, s) >= n.r + CLEAR)
        && labels.every(r => r.x > x1 + CLEAR || r.x + r.w < x0 - CLEAR || r.y > y1 + CLEAR || r.y + r.h < y0 - CLEAR || !crosses(s, r, CLEAR));
    });
    // 같은 레인(또는 틈 안의 같은 세로 줄)을 따라 겹쳐 가는 선은 같은 부모의 줄기이거나 같은 자식으로 합치는 가지일 때만 허용한다.
    // 그은 곧은 조각은 방향·자리(반올림)별로 묶어 둔다 — 세로 줄은 2px 안이면 같은 줄로 본다.
    const lineIndex = new Map<string, { from: string | null; to: string; line: Line }[]>();
    const lineKey = (flat: boolean, at: number) => `${flat ? 1 : 0}:${at}`;
    const remember = (e: HPlaced) => { for (const line of e.lines) { const key = lineKey(line.flat, Math.round(line.at)); lineIndex.set(key, [...(lineIndex.get(key) ?? []), { from: e.from, to: e.to, line }]); } };
    const free = (points: readonly Point[], from: string | null, to: string) => linesOf(points).every(h => {
      for (let at = Math.round(h.at) - (h.flat ? 0 : 2); at <= Math.round(h.at) + (h.flat ? 0 : 2); at++) {
        for (const o of lineIndex.get(lineKey(h.flat, at)) ?? []) if (o.from !== from && o.to !== to && Math.abs(o.line.at - h.at) <= 2 && o.line.hi > h.lo + 1 && o.line.lo < h.hi - 1) return false;
      }
      return true;
    });
    const ok = (points: readonly Point[], from: string | null, to: string) => clear(points, [from, to]) && free(points, from, to);
    // 새 노드와 그 이름 칸은 이미 그은 선을 덮지 않는다 — 지나가는 선이 있는 레인 자리에는 노드를 두지 않는다.
    const roomFor = (c: Point) => {
      const label = labelOf(c);
      return placed.every(e => segments(e.points).every(s => distance(c, s) >= g.r + CLEAR && !crosses(s, label, CLEAR)));
    };
    const dedupe = (points: readonly Point[]) => points.filter((q, i) => !i || Math.abs(q.x - points[i - 1]!.x) > .01 || Math.abs(q.y - points[i - 1]!.y) > .01);
    /**
     * 틈 k에서 레인 x → y로 옮기는 길 후보(싼 것부터) — 한 번의 45° 가지가 틈에 들어가면 그것, 아니면 45°로 갈라져 틈 안을 곧게 내려가고(올라가고)
     * 45°로 레인에 드는 줄기-가지다. 다른 선이 그 세로 줄을 쓰고 있으면 틈 안의 다음 줄로 비킨다. end 는 틈 뒤 이어 갈 x(자식이면 그 가운데)다.
     */
    const shifts = (k: number, x: number, y: number, end: number, last: boolean) => {
      const span = Math.abs(x - y), dir = Math.sign(y - x), y0 = laneY(x), y1 = laneY(y), out: { points: Point[]; cost: number }[] = [];
      if (!span) return [{ points: [{ x: gs(k), y: y0 }, { x: end, y: y0 }], cost: 0 }];
      const room = (last ? end : ge(k)) - gs(k);
      if (span * g.laneH <= room + .01) out.push({ points: [{ x: gs(k), y: y0 }, { x: gs(k) + span * g.laneH, y: y1 }, { x: end, y: y1 }], cost: .5 });
      const half = g.laneH / 2, trackRoom = ge(k) - gs(k);
      const tracks: { v: number; c: number }[] = [];
      if (span > 1 && 2 * half <= trackRoom + .01) tracks.push({ v: gs(k) + half, c: half });
      for (let v = gs(k) + CHAMFER; v <= ge(k) - CHAMFER + .01; v += TRACK) tracks.push({ v, c: CHAMFER });
      for (const [i, { v, c }] of tracks.entries()) out.push({ points: [{ x: gs(k), y: y0 }, { x: v - c, y: y0 }, { x: v, y: y0 + dir * c }, { x: v, y: y1 - dir * c }, { x: v + c, y: y1 }, { x: end, y: y1 }], cost: .6 + (c === half ? 0 : .2 + i * .02) });
      return out;
    };
    interface Way { cost: number; points: Point[] }
    /**
     * 부모에서 자식 열 앞 틈(gs(d))까지 레인별로 가장 싼 길 — 지나는 틈마다 레인을 한 번 바꿀 수 있고, 열은 제 레인을 따라 곧게 지난다.
     * 자식 레인과 무관하므로 자식 레인 후보마다 다시 찾지 않는다.
     */
    const reach = (from: string | null, to: string, d: number, lo: number, hi: number) => {
      const p = at(from), a = from ? depth.get(from)! : -1, lp = from ? lane.get(from)! : 0;
      let ways = new Map<number, Way>();
      const start = dedupe([p, { x: gs(a + 1), y: p.y }]);
      if (ok(start, from, to)) ways.set(lp, { cost: 0, points: start });
      for (let k = a + 1; k < d; k++) {
        const next = new Map<number, Way>();
        for (const [x, way] of ways) for (let y = lo; y <= hi; y++) {
          const base = way.cost + Math.abs(x - y) + (x !== y ? (k - a) * .01 : 0);
          if ((next.get(y)?.cost ?? Infinity) <= base) continue;
          for (const shift of shifts(k, x, y, gs(k + 1), false)) {
            const cost = base + shift.cost;
            if ((next.get(y)?.cost ?? Infinity) <= cost) break;
            const step = dedupe(shift.points);
            if (!ok(step, from, to)) continue;
            next.set(y, { cost, points: dedupe([...way.points, ...step.slice(1)]) });
            break;
          }
        }
        ways = next;
      }
      return ways;
    };
    /** 마지막 틈에서 자식 레인으로 들어간다 — 한 번의 가지가 들어가면 자식 가운데까지 비스듬히, 아니면 틈 안의 줄기로. */
    const arrive = (ways: ReadonlyMap<number, Way>, from: string | null, to: string, c: Point, l: number, d: number) => {
      let best: Way | null = null;
      for (const [x, way] of ways) {
        const base = way.cost + Math.abs(x - l);
        if (best && best.cost <= base) continue;
        for (const shift of shifts(d, x, l, c.x, true)) {
          const cost = base + shift.cost;
          if (best && best.cost <= cost) break;
          const step = dedupe(shift.points);
          if (!ok(step, from, to)) continue;
          best = { cost, points: dedupe([...way.points, ...step.slice(1)]) };
          break;
        }
      }
      return best;
    };
    for (const m of order) {
      const d = depth.get(m.id) ?? 0, parents = parentsOf(m), sources: (string | null)[] = parents.length ? parents : [null];
      const sourceLanes = sources.map(from => from ? lane.get(from)! : 0);
      const anchor = Math.min(...sourceLanes);
      const used = [...lane.values(), ...placed.flatMap(e => [e.lo, e.hi]), 0];
      const lo = Math.min(...used) - 1, hi = Math.max(...used) + sources.length + 2;
      // 한 열 안에서는 편성 순서대로 위에서 아래로 선다 — 앞 임무보다 아래 레인만 본다. 노드는 뿌리 레인(0)보다 위로 가지 않는다.
      const floor = (last.get(d) ?? -1) + 1;
      // 노드 레인 비용 — 부모 레인에 가까울수록(합류는 가장 위 부모 쪽) 싸다.
      const nodeCost = (l: number) => Math.abs(l - anchor) * 1.5;
      const candidates = Array.from({ length: Math.max(0, hi - floor + 1) }, (_, i) => floor + i).sort((a, b) => nodeCost(a) - nodeCost(b) || a - b);
      const reaches = sources.map(from => reach(from, m.id, d, lo, hi + 1));
      let best: { cost: number; l: number; edges: HPlaced[] } | null = null;
      for (const l of candidates) {
        if (best && nodeCost(l) >= best.cost) break;
        const c = { x: colX(d), y: laneY(l) }, label = labelOf(c);
        if (!roomFor(c) || labels.some(r => intersects(r, label, 2) || crosses({ a: c, b: c }, r, g.r + CLEAR))) continue;
        const edges: HPlaced[] = [];
        let cost = nodeCost(l);
        for (const [k, from] of sources.entries()) {
          if (best && cost >= best.cost) break;
          const way = arrive(reaches[k]!, from, m.id, c, l, d);
          if (!way) { cost = Infinity; break; }
          cost += way.cost;
          const ls = way.points.map(q => Math.round(q.y / g.laneH));
          edges.push({ from, to: m.id, points: way.points, lines: linesOf(way.points), lo: Math.min(...ls), hi: Math.max(...ls) });
        }
        if (cost < (best?.cost ?? Infinity)) best = { cost, l, edges };
      }
      // 맞는 자리가 없으면 그 열 앞이 좁은 것이다 — 아래 바깥 레인에 곧은 선으로 두고, 바깥 루프가 그 간격을 넓혀 다시 배정한다.
      const l = best?.l ?? Math.max(floor, hi + 1);
      if (!best) failed.add(d);
      lane.set(m.id, l); last.set(d, l);
      for (const e of best?.edges ?? sources.map(from => ({ from, to: m.id, points: [at(from), at(m.id)], lines: [], lo: Math.min(l, from ? lane.get(from)! : 0), hi: l }))) { placed.push(e); remember(e); }
      const c = at(m.id);
      nodes.push({ id: m.id, at: c, r: g.r });
      labels.push(labelOf(c));
    }
    const result = { lane, placed, failed };
    if (hAssigned.size >= ASSIGNED_LIMIT) hAssigned.delete(hAssigned.keys().next().value!);
    hAssigned.set(key, result);
    return result;
  };
  // 비킬 자리가 없으면 그 열 앞의 간격을 한 레인씩 넓혀 다시 배정한다 — 45° 가지가 들어갈 만큼 넓어지면 아래 바깥 레인은 늘 빈다.
  const gaps = Array.from({ length: cols }, (_, d) => d ? colGap(labelW) : rootGap);
  let run = assign(gaps);
  for (let k = 0; k < WIDEN_LIMIT && run.failed.size; k++) {
    for (const d of run.failed) gaps[d]! += g.laneH;
    run = assign(gaps);
  }
  const colX = (d: number) => rootX + gaps.slice(0, d + 1).reduce((a, b) => a + b, 0);
  const laneSet = [0, ...run.lane.values(), ...run.placed.flatMap(e => [e.lo, e.hi])];
  const minLane = Math.min(...laneSet), maxLane = Math.max(...laneSet);
  // 맨 윗레인 위로는 노드 표식(r+7)과, 뿌리가 맨 위면 그 위의 지휘관 이름 칸이 들어갈 여백을 둔다.
  const top = Math.max(g.r + 10, minLane === 0 ? g.rootR + 22 : 0) - laneY(minLane);
  const shift = (p: Point) => ({ x: p.x, y: p.y + top });
  const pos = new Map<string, Point>([...run.lane].map(([id, l]) => [id, shift({ x: colX(depth.get(id) ?? 0), y: laneY(l) })]));
  const root = shift({ x: rootX, y: 0 });
  const edges: GraphEdge[] = run.placed.map(e => ({ from: e.from, to: e.to, d: roundedPath(e.points.map(shift), 6) }));
  const labels = new Map<string, Rect>([...pos].map(([id, p]) => [id, { x: p.x - g.r, y: p.y + labelDy, w: labelW, h: labelH }]));
  const rootLabel: Rect = { x: root.x - g.rootR, y: root.y - g.rootR - 18, w: ROOT_LABEL_W, h: 14 };
  const right = Math.max(rootX - g.rootR + ROOT_LABEL_W, ...[...labels.values()].map(l => l.x + l.w));
  const height = laneY(maxLane) + top + labelDy + labelH + 8;
  return { g, pos, root, rootLabel, edges, labels, width: Math.max(width, Math.ceil(right + g.pad)), height: Math.ceil(height) };
}

export type HorizontalLayout = ReturnType<typeof horizontalLayout>;
