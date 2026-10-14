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
/** 늦춤 쌍(부모 쪽, 자식 쪽)을 덜 늦춘 것부터 — 합이 같으면 부모 쪽을 덜 늦춘 것부터다. [부모 레인이 이동 레인인가][자식 레인이 이동 레인인가] — 그쪽은 늦추지 않는다. */
const DELAYS = [false, true].map(fixA => [false, true].map(fixB =>
  (fixA ? [0] : OFFSETS).flatMap(a => (fixB ? [0] : OFFSETS).map(b => [a, b] as const)).sort((x, y) => x[0] + x[1] - y[0] - y[1])));
/** 레인 배정 캐시 — 배정은 선행 모양·폭 단계·레인 간격에만 달려, 레일을 끄는 동안 바뀌는 폭은 담아 둔 배정을 다시 쓴다. routed 가 거짓이면 탐색 대신 버스 배치다. */
const assigned = new Map<string, { lane: Map<string, number>; placed: Placed[]; lanes: number; routed: boolean }>();
const ASSIGNED_LIMIT = 32;
/**
 * 세로 길 찾기 예산 — 배정 한 번이 견준 노드·선분 쌍과 세로 구간 쌍의 수, 후보 길마다의 고정 몫(TRY_COST)의 합의 상한. 다 쓰면 탐색을 멈추고 버스 배치로 간다.
 * 작업량으로 세어 같은 모양은 늘 같은 배치가 된다. 일반 크기(희소 30개 안팎, 완전 DAG 16개까지)는 안에 들고(희소 25개가 약 500만),
 * 완전 DAG 40개는 예산을 다 쓰고 버스로 그려도 한 배치가 수십 ms 에 끝나게 잰 값이다. 좁혀 다시 배정하면 그 배정도 따로 예산을 받는다.
 */
const ROUTE_BUDGET = 20_000_000;
const TRY_COST = 20;
/** 세로 버스 배치의 꺾임(45°) 크기. */
const BUS_K = 8;

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
  type Assigned = { lane: Map<string, number>; placed: Placed[]; lanes: number; routed: boolean };
  /** 줄기-가지 길 찾기 — ROUTE_BUDGET 을 다 쓰면 null 이다. */
  const search = (lx: (l: number) => number): Assigned | null => {
    let budget = ROUTE_BUDGET;
    const lane = new Map<string, number>();
    const nodes: { id: string | null; at: Point; r: number }[] = [{ id: null, at: { x: lx(0), y: rowY(0) }, r: g.rootR }];
    const placed: Placed[] = [];
    // 그은 선의 세로 구간을 레인 x 별로 묶는다 — 레인 x 는 늘 정수라 같은 레인은 같은 키다.
    const columns = new Map<number, { from: string | null; to: string; y1: number; y2: number }[]>();
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
    // 노드는 줄 순서대로 쌓여 nodes[k] 가 k 줄에 선다 — 길의 y 범위에서 (반지름 + 여유)보다 먼 줄의 노드는 견주지 않아도 비킨다.
    const reach = Math.max(g.r, g.rootR) + CLEAR;
    const clear = (points: readonly Point[], ends: readonly (string | null)[]) => {
      // 선분마다 둘레 상자를 한 번 잰다 — 상자를 노드 여유만큼 넓혀도 밖이면 거리는 여유 이상이라 거리 계산을 건너뛴다.
      const boxes = segments(points).map(s => ({ s, x0: Math.min(s.a.x, s.b.x), x1: Math.max(s.a.x, s.b.x), y0: Math.min(s.a.y, s.b.y), y1: Math.max(s.a.y, s.b.y) }));
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const q of points) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
      const last = Math.min(nodes.length - 1, Math.ceil((y1 + reach - g.rowH / 2) / g.rowH));
      for (let k = Math.max(0, Math.floor((y0 - reach - g.rowH / 2) / g.rowH)); k <= last; k++) {
        const n = nodes[k]!, need = n.r + CLEAR, { x, y } = n.at;
        budget -= boxes.length;
        if (x <= x0 - need || x >= x1 + need || ends.includes(n.id)) continue;
        for (const q of boxes) if (x > q.x0 - need && x < q.x1 + need && y > q.y0 - need && y < q.y1 + need && distance(n.at, q.s) < need) return false;
      }
      return true;
    };
    // 같은 레인을 따라 겹쳐 내려가는 선은 같은 부모의 줄기이거나 같은 자식으로 합치는 가지일 때만 허용한다(한 노드로 드는 다른 부모의 선끼리는 늘 같은 자식이다).
    const free = (verticals: readonly Vertical[], from: string | null, to: string) => verticals.every(v => {
      const column = columns.get(v.x) ?? [];
      budget -= column.length;
      return column.every(o => o.from === from || o.to === to || o.y2 <= v.y1 + 1 || o.y1 >= v.y2 - 1);
    });
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
          const attempt = (points: Point[], delay: number, t: number) => {
            if (!clear(points, [from, m.id])) return null;
            const verticals = verticalsOf(points);
            if (!free(verticals, from, m.id)) return null;
            const bow = !merge && t !== l ? 2 : 0;
            return { cost: (t - lp) + (t - l) + (points.length - 2) * .5 + delay * .25 + bow, edge: { from, to: m.id, points, verticals, lane: t } };
          };
          for (let t = base; t <= limit + 1 && !chosen; t++) {
            if (budget < 0) return null;
            // 같은 이동 레인에서는 가지를 덜 늦춘 길부터 본다 — 늦춤은 바깥 레인으로 도는 것보다 가볍다.
            // 후보 길은 싼 것부터 하나씩 만든다 — 앞의 후보로 정해지면 뒤의 길은 만들지 않는다.
            let routable = false;
            for (const [a, b] of DELAYS[+(t === lp)]![+(t === l)]!) {
              if ((budget -= TRY_COST) < 0) return null;
              const points = route(p, c, t, a * g.rowH, b * g.rowH);
              if (!points) continue;
              routable = true;
              if ((chosen = attempt(points, a + b, t))) break;
            }
            // 바로 아래 줄로 두 레인까지 건너는데 두 가지가 줄 사이에 안 들어갈 때만 곧은 사선 하나로 잇는다.
            if (!routable && t === base && Math.abs(lp - l) <= 2) chosen = attempt([p, c], 2, t);
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
      for (const e of best?.edges ?? sources.map(from => ({ from, to: m.id, points: [at(from), at(m.id)], verticals: [], lane: l }))) {
        placed.push(e);
        for (const v of e.verticals) { const column = columns.get(v.x); if (column) column.push({ from: e.from, to: e.to, y1: v.y1, y2: v.y2 }); else columns.set(v.x, [{ from: e.from, to: e.to, y1: v.y1, y2: v.y2 }]); }
      }
    }
    // 이름 칸은 노드뿐 아니라 바깥으로 돈 선이 쓴 레인보다도 오른쪽에 선다.
    return { lane, placed, lanes: Math.max(0, ...lane.values(), ...placed.map(e => e.lane)), routed: true };
  };
  /**
   * 보장된 버스 배치 — 길 찾기가 예산을 다 쓰면 쓴다. 겹침을 검사하지 않고 구조로 비킨다. 노드는 모두 0레인에 편성 순서대로 선다.
   * - 곧은 선: 바로 아랫줄 자식에게는 0레인을 따라 곧게 내려간다(사이에 노드가 없다).
   * - 버스: 나머지는 부모 가운데 높이에서 오른쪽으로 나가 45°로 꺾여 바깥 레인을 내려가고, 자식 위의 드는 줄에서 45°로 꺾여 왼쪽으로 온 뒤
   *   45°로 0레인에 들어 자식에 닿는다. 나가는 줄은 노드마다 제 가운데 높이, 드는 줄은 제 위라서 남의 줄과 겹치지 않는다 — 같은 부모·같은 자식끼리만 함께 쓴다.
   * - 바깥 레인은 부모마다 또는 자식마다 하나(같은 부모·같은 자식끼리는 줄기를 함께 쓴다) 중 레인이 적게 드는 쪽으로 묶고, y 구간이 안 겹치면 나눠 쓴다.
   *   안쪽 레인은 늦게 나가는 부모(자식마다면 일찍 드는 자식)가 써서, 완전 DAG 에서는 나가는 줄·드는 줄이 남의 버스와 엇갈리지 않는다.
   */
  const bus = (lx: (l: number) => number): Assigned => {
    // 드는 줄은 윗줄 노드의 담당 표식(r+10 아래)과 이 노드의 기록 표식(r+6 위) 사이 가운데, 꺾임은 BUS_K 다.
    const into = g.rowH / 2 - 1, k = BUS_K, x0 = lx(0);
    const rowOf = (id: string | null) => id ? row.get(id)! : 0;
    const links = order.flatMap(m => { const parents = parentsOf(m); return (parents.length ? parents : [null]).map(from => ({ from, to: m.id })); });
    const buses = new Set(links.filter(e => rowOf(e.to) - rowOf(e.from) !== 1));
    const spanOf = (e: { from: string | null; to: string }) => { const a = rowY(rowOf(e.from)), b = rowY(rowOf(e.to)) - into; return { lo: Math.min(a, b), hi: Math.max(a, b) }; };
    const pack = (keyOf: (e: { from: string | null; to: string }) => string, inner: (a: { lo: number; hi: number }, b: { lo: number; hi: number }) => number) => {
      const spans = new Map<string, { lo: number; hi: number }>();
      for (const e of buses) { const key = keyOf(e), span = spanOf(e), old = spans.get(key); spans.set(key, old ? { lo: Math.min(old.lo, span.lo), hi: Math.max(old.hi, span.hi) } : span); }
      const used: { lo: number; hi: number }[][] = [], lanes = new Map<string, number>();
      for (const [key, span] of [...spans].sort((a, b) => inner(a[1], b[1]))) {
        let l = used.findIndex(list => list.every(o => o.hi < span.lo - TRACK || o.lo > span.hi + TRACK));
        if (l < 0) { l = used.length; used.push([]); }
        used[l]!.push(span); lanes.set(key, l + 1);
      }
      return { lanes, count: used.length, keyOf };
    };
    const byParent = pack(e => `\u0001${e.from ?? ""}`, (a, b) => b.lo - a.lo), byChild = pack(e => e.to, (a, b) => a.hi - b.hi);
    const packed = byChild.count < byParent.count ? byChild : byParent;
    const placed = links.map((e): Placed => {
      const p = { x: x0, y: rowY(rowOf(e.from)) }, c = { x: x0, y: rowY(rowOf(e.to)) };
      if (!buses.has(e)) return { from: e.from, to: e.to, points: [p, c], verticals: [], lane: 0 };
      const l = packed.lanes.get(packed.keyOf(e))!, xb = lx(l), yi = c.y - into, dir = Math.sign(yi - p.y);
      const points = [p, { x: xb - k, y: p.y }, { x: xb, y: p.y + dir * k }, { x: xb, y: yi - dir * k }, { x: xb - k, y: yi }, { x: x0 + k, y: yi }, { x: x0, y: yi + k }, c];
      return { from: e.from, to: e.to, points: points.filter((q, i) => !i || Math.abs(q.x - points[i - 1]!.x) > .01 || Math.abs(q.y - points[i - 1]!.y) > .01), verticals: [], lane: l };
    });
    return { lane: new Map(order.map(m => [m.id, 0])), placed, lanes: packed.count, routed: false };
  };
  const assign = (step: number, route: boolean) => {
    const lx = (l: number) => g.pad + g.r + l * step;
    const key = `${wide}\u0003${step}\u0003${route ? "" : "bus"}\u0003${shape}`, hit = assigned.get(key);
    if (hit) { assigned.delete(key); assigned.set(key, hit); return { ...hit, lx }; }
    const result = (route ? search(lx) : null) ?? bus(lx);
    if (assigned.size >= ASSIGNED_LIMIT) assigned.delete(assigned.keys().next().value!);
    assigned.set(key, result);
    return { ...result, lx };
  };
  // 레인이 많아 이름 칸이 MIN_LABEL 보다 좁아지면 간격을 줄여 다시 배정한다 — 가지는 45°를 지키고 겹침 판정도 줄인 간격으로 다시 한다.
  // 넓은 간격에서 이미 버스로 갔으면 좁힌 간격도 버스로 그린다 — 같은 모양은 같은 간격에서 늘 같은 배치가 된다.
  const room = width - 2 * g.pad - 2 * g.r - 14 - MIN_LABEL;
  const narrowed = (lanes: number) => lanes && room / lanes < g.lane ? Math.max(MIN_LANE, Math.floor(room / lanes)) : g.lane;
  let run = assign(g.lane, true), step = g.lane;
  if (narrowed(run.lanes) !== step) { step = narrowed(run.lanes); run = assign(step, run.routed); }
  // 좁힌 간격에서 처음 버스로 갔으면 버스의 레인 수로 간격을 다시 정한다 — 버스의 레인 수는 간격과 무관해 한 번이면 된다.
  if (!run.routed && narrowed(run.lanes) !== step) { step = narrowed(run.lanes); run = assign(step, false); }
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
  const clip = (p: number, q: number) => {
    if (Math.abs(p) < 1e-9) return q >= 0;
    const k = q / p;
    if (p < 0) { if (k > t1) return false; if (k > t0) t0 = k; } else { if (k < t0) return false; if (k < t1) t1 = k; }
    return true;
  };
  return clip(-dx, s.a.x - x0) && clip(dx, x1 - s.a.x) && clip(-dy, s.a.y - y0) && clip(dy, y1 - s.a.y);
}
/**
 * 곧은 조각 — dir 0 가로(at 은 y), 1 세로(at 은 x), 2 오른쪽 아래로 가는 45°(at 은 y-x), 3 오른쪽 위로 가는 45°(at 은 y+x).
 * lo·hi 는 세로면 y, 나머지는 x 구간이다.
 */
interface Line { dir: 0 | 1 | 2 | 3; at: number; lo: number; hi: number }
/** 그은 선 — lo·hi 는 선이 지난 가장 위·아래 레인이다(캔버스 높이와 다음 배정의 바깥 레인을 정한다). */
interface HPlaced { from: string | null; to: string; points: Point[]; lines: Line[]; lo: number; hi: number }
/**
 * 레인 배정 — 열의 x, 노드 레인, 그은 선. routed 가 거짓이면 탐색 대신 보장된 버스 배치다. detoured 는 탐색이 찾지 못해 버스(또는 새 레인의 곧은 선)로
 * 그린 선의 수다 — 전체 버스 배치면 모든 선, 부분 버스 배치면 그 일부, 탐색이 다 찾았으면 0.
 */
interface HAssigned { lane: Map<string, number>; placed: HPlaced[]; xs: number[]; routed: boolean; detoured: number }
/** 가로 배치의 레인 배정 캐시 — 배정은 선행 모양·폭 단계(이름 칸 폭)에만 달린다. */
const hAssigned = new Map<string, HAssigned>();
/**
 * 길 찾기 예산 — 겹침·교차 검사가 들여다본 칸·노드·이름·선분 수와 검사마다의 고정 몫(OK_COST)의 합의 상한. 넓혀 다시 배정하는 것까지 한 배치
 * 전체가 나눠 쓴다. 다 쓰면 탐색을 멈추고 보장된 버스 배치로 간다. 조밀한 그래프(앞선 임무를 모두 선행으로 갖거나 두 층이 모두 이어진 40개)에서도
 * 한 배치가 수십 ms(가장 무거운 두 층 40개가 약 80ms)에 끝나게 잰 값이다.
 */
const SEARCH_BUDGET = 6_500_000;
/** 검사 한 번의 고정 몫 — 후보 길을 만들고 줄 세우는 일도 예산에 들도록 한다. */
const OK_COST = 300;
/** 지휘관(뿌리) 이름 칸의 폭 — 뿌리 위에 한 줄로 선다. */
const ROOT_LABEL_W = 80;
/** 비킬 자리가 없어 열 사이를 넓혀 다시 배정하는 횟수의 상한. */
const WIDEN_LIMIT = 12;
/** 틈 안 줄기의 꺾임(45°) 크기와, 다른 선이 쓰는 줄을 비킬 때의 간격. */
const CHAMFER = 12;
const TRACK = 6;
/** 뿌리 레인 위로 도는 우회 레인의 덧비용 — 첫 줄 위에 빈 띠가 생긴다. 교차(CROSS)보다는 가볍다. */
const ABOVE = 1;
/** 무관한 선과 한 번 엇갈릴 때의 덧비용 — 레인 몇 칸을 더 돌거나 빈 띠를 두는 편이 선끼리 엇갈리는 것보다 읽기 쉽다. */
const CROSS = 3;
/** 장애물·그은 선분을 묶는 칸의 한 변. */
const CELL = 64;

/** 2차원 칸 묶음 — 항목을 제 둘레 상자가 걸친 칸마다 담고, 질의 상자와 겹치는 칸의 것만 한 번씩 꺼낸다. visit 은 들여다본 칸·항목 수를 돌려준다(예산). */
class Grid<T> {
  private cells = new Map<number, { item: T; mark: number }[]>();
  private round = 0;
  /** fn 이 false 를 돌려주면 남은 칸을 돌지 않는다. */
  private span(x0: number, y0: number, x1: number, y1: number, fn: (key: number) => boolean | void) {
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) if (fn((cx + 32768) * 65536 + cy + 32768) === false) return;
  }
  add(x0: number, y0: number, x1: number, y1: number, item: T) {
    const entry = { item, mark: 0 };
    this.span(x0, y0, x1, y1, key => { const cell = this.cells.get(key); if (cell) cell.push(entry); else this.cells.set(key, [entry]); });
  }
  /** fn 이 false 를 돌려주면 멈춘다. */
  visit(x0: number, y0: number, x1: number, y1: number, fn: (item: T) => boolean) {
    const round = ++this.round;
    let work = 0, going = true;
    this.span(x0, y0, x1, y1, key => {
      work++;
      const cell = this.cells.get(key);
      if (!cell) return true;
      work += cell.length;
      for (const entry of cell) {
        if (entry.mark === round) continue;
        entry.mark = round;
        if (!fn(entry.item)) { going = false; return false; }
      }
      return true;
    });
    return { work, going };
  }
}

/**
 * 두 선분이 만나는가 — 반열린 구간으로 본다: 각 선분의 시작점은 넣고 끝점은 뺀다. 꺾은선의 꺾임점은 그 뒤 선분에만 속하므로, 꺾임점에서 남의 선을
 * 지나가는 교차도 한 번만 센다. 한 줄로 겹치는 것은 세지 않는다(겹침은 free 가 막는다).
 */
function cut(s: Segment, t: Segment) {
  const rx = s.b.x - s.a.x, ry = s.b.y - s.a.y, qx = t.b.x - t.a.x, qy = t.b.y - t.a.y, den = rx * qy - ry * qx;
  if (Math.abs(den) < 1e-9) return false;
  const ux = t.a.x - s.a.x, uy = t.a.y - s.a.y, k = (ux * qy - uy * qx) / den, m = (ux * ry - uy * rx) / den;
  return k > -1e-6 && k < 1 - 1e-6 && m > -1e-6 && m < 1 - 1e-6;
}

/**
 * 가로 배치 — 차수(선행 깊이)마다 한 열을 두어 같은 차수의 임무는 같은 x에 선다. 한 열 안의 임무는 편성 순서대로 위에서 아래 레인(줄)에 서고,
 * 간선은 세로 배치와 같은 줄기-가지다: 제 레인을 따라 곧게 오른쪽으로 가다 갈라지고 합칠 때만 45° 가지를 친다. 가지는 열 사이 틈에서만 치고,
 * 한 번의 45°로 틈에 못 들어가는 먼 레인은 45°로 갈라져 틈 안을 곧게 내려간(올라간) 뒤 45°로 든다.
 * 이름은 노드 아래(담당 표식 밑)에서 오른쪽으로 열 안에 서고, 선은 노드·이름·다른 선의 곧은 조각을 비켜 간다 — 비킬 자리가 없으면 그 열 앞을 넓혀 다시 배정하고,
 * 길 찾기 예산을 다 쓰거나 끝내 못 찾으면 찾은 선은 두고 못 찾은 임무로 드는 선만 버스로 그리며(partial), 그것도 못 하면 겹침이 구조적으로 없는
 * 버스 배치(bus)로 그린다.
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
  let budget = SEARCH_BUDGET;
  /** keep 이 있으면 차수 upto 앞의 열은 그 배정을 그대로 옮겨 놓고 그 열부터 다시 찾는다 — 그 앞 열의 x 와 그리로 가는 선은 넓힌 간격과 무관하다. */
  const assign = (gaps: readonly number[], keep?: { lane: ReadonlyMap<string, number>; placed: readonly HPlaced[] }, upto = 0) => {
    const xs = gaps.map((_, d) => rootX + gaps.slice(0, d + 1).reduce((a, b) => a + b, 0)), colX = (d: number) => xs[d]!;
    const lane = new Map<string, number>(), failed = new Set<number>(), last = new Map<number, number>(), stranded: string[] = [];
    const nodes: { id: string | null; at: Point; r: number }[] = [{ id: null, at: { x: rootX, y: 0 }, r: g.rootR }];
    const labels: Rect[] = [{ x: rootX - g.rootR, y: -g.rootR - 18, w: ROOT_LABEL_W, h: 14 }];
    const placed: HPlaced[] = [];
    const at = (id: string | null): Point => id ? { x: colX(depth.get(id) ?? 0), y: laneY(lane.get(id)!) } : { x: rootX, y: 0 };
    const labelOf = (p: Point): Rect => ({ x: p.x - g.r, y: p.y + labelDy, w: labelW, h: labelH });
    // 가지는 열 사이(이름 칸이 끝난 뒤부터 다음 열 노드 앞까지)의 틈에서만 친다 — 노드와 이름은 열 안에만 있으니 틈의 선은 아무것도 덮지 않는다.
    // gs(k)는 k열 앞 틈의 시작(뿌리 틈은 뿌리 가운데), ge(k)는 그 끝이다.
    const gs = (k: number) => k ? colX(k - 1) - g.r + labelW + CLEAR : rootX;
    const ge = (k: number) => colX(k) - g.r - CLEAR - 4;
    const linesOf = (points: readonly Point[]): Line[] => segments(points).flatMap((q): Line[] => {
      const dx = q.b.x - q.a.x, dy = q.b.y - q.a.y, x0 = Math.min(q.a.x, q.b.x), x1 = Math.max(q.a.x, q.b.x);
      if (Math.abs(dy) < .01) return [{ dir: 0, at: q.a.y, lo: x0, hi: x1 }];
      if (Math.abs(dx) < .01) return [{ dir: 1, at: q.a.x, lo: Math.min(q.a.y, q.b.y), hi: Math.max(q.a.y, q.b.y) }];
      if (Math.abs(Math.abs(dx) - Math.abs(dy)) < .01) return dx * dy > 0 ? [{ dir: 2, at: q.a.y - q.a.x, lo: x0, hi: x1 }] : [{ dir: 3, at: q.a.y + q.a.x, lo: x0, hi: x1 }];
      return [];
    }).filter(q => q.hi - q.lo > .5);
    // 노드·이름은 칸 묶음에 담아, 선분마다 제 둘레 칸의 것만 견준다 — 틈의 선분 둘레에는 대개 아무것도 없다.
    type Obstacle = { node: { id: string | null; at: Point; r: number } } | { label: Rect };
    const obstacles = new Grid<Obstacle>();
    const addNode = (n: { id: string | null; at: Point; r: number }) => { nodes.push(n); obstacles.add(n.at.x - n.r - CLEAR, n.at.y - n.r - CLEAR, n.at.x + n.r + CLEAR, n.at.y + n.r + CLEAR, { node: n }); };
    const addLabel = (r: Rect) => { labels.push(r); obstacles.add(r.x - CLEAR, r.y - CLEAR, r.x + r.w + CLEAR, r.y + r.h + CLEAR, { label: r }); };
    obstacles.add(rootX - g.rootR - CLEAR, -g.rootR - CLEAR, rootX + g.rootR + CLEAR, g.rootR + CLEAR, { node: nodes[0]! });
    obstacles.add(labels[0]!.x - CLEAR, labels[0]!.y - CLEAR, labels[0]!.x + labels[0]!.w + CLEAR, labels[0]!.y + labels[0]!.h + CLEAR, { label: labels[0]! });
    const clear = (points: readonly Point[], ends: readonly (string | null)[]) => segments(points).every(s => {
      const { work, going } = obstacles.visit(Math.min(s.a.x, s.b.x), Math.min(s.a.y, s.b.y), Math.max(s.a.x, s.b.x), Math.max(s.a.y, s.b.y), o =>
        "node" in o ? ends.includes(o.node.id) || distance(o.node.at, s) >= o.node.r + CLEAR : !crosses(s, o.label, CLEAR));
      budget -= work;
      return going;
    });
    // 같은 레인·틈 안의 같은 세로 줄·같은 45° 사선을 따라 겹쳐 가는 선은 같은 부모의 줄기이거나 같은 자식으로 합치는 가지일 때만 허용한다.
    // 그은 곧은 조각은 방향·자리(반올림)별로 묶어 둔다 — 세로 줄은 2px 안이면 같은 줄로 본다.
    const lineIndex = new Map<string, { from: string | null; to: string; line: Line }[]>();
    const lineKey = (dir: number, at: number) => `${dir}:${at}`;
    // 교차 셈 — 그은 선분을 칸 묶음에 담아, 새 길의 선분과 같은 칸의 것만 견준다. 같은 노드에 닿는 선끼리(줄기·합류)는 세지 않는다.
    const drawn = new Grid<{ from: string | null; to: string; s: Segment }>();
    const crossings = (points: readonly Point[], from: string | null, to: string) => {
      let n = 0;
      for (const s of segments(points)) {
        budget -= drawn.visit(Math.min(s.a.x, s.b.x), Math.min(s.a.y, s.b.y), Math.max(s.a.x, s.b.x), Math.max(s.a.y, s.b.y), o => {
          if (o.from !== from && o.to !== to && o.from !== to && o.to !== from && cut(s, o.s)) n++;
          return true;
        }).work;
      }
      return n;
    };
    const remember = (e: HPlaced) => {
      for (const s of segments(e.points)) drawn.add(Math.min(s.a.x, s.b.x), Math.min(s.a.y, s.b.y), Math.max(s.a.x, s.b.x), Math.max(s.a.y, s.b.y), { from: e.from, to: e.to, s });
      for (const line of e.lines) { const key = lineKey(line.dir, Math.round(line.at)), bucket = lineIndex.get(key); if (bucket) bucket.push({ from: e.from, to: e.to, line }); else lineIndex.set(key, [{ from: e.from, to: e.to, line }]); } };
    // 가로는 같은 y, 세로는 2px, 45°는 절편 2(약 1.4px) 안이면 한 줄로 본다 — 무관한 선이 45°로 겹쳐 가는 것도 막는다.
    const free = (points: readonly Point[], from: string | null, to: string) => linesOf(points).every(h => {
      for (let at = Math.round(h.at) - (h.dir ? 2 : 0); at <= Math.round(h.at) + (h.dir ? 2 : 0); at++) {
        const bucket = lineIndex.get(lineKey(h.dir, at)) ?? [];
        budget -= bucket.length;
        for (const o of bucket) if (o.from !== from && o.to !== to && Math.abs(o.line.at - h.at) <= 2 && o.line.hi > h.lo + 1 && o.line.lo < h.hi - 1) return false;
      }
      return true;
    });
    // 예산은 검사한 횟수가 아니라 비교량으로 깎는다 — 그래프가 클수록 한 번의 검사가 무거워진다.
    const ok = (points: readonly Point[], from: string | null, to: string) => (budget -= OK_COST) >= 0 && clear(points, [from, to]) && free(points, from, to);
    // 새 노드와 그 이름 칸은 이미 그은 선을 덮지 않는다 — 지나가는 선이 있는 레인 자리에는 노드를 두지 않는다.
    const roomFor = (c: Point) => {
      const label = labelOf(c);
      const { work, going } = drawn.visit(c.x - g.r - CLEAR, c.y - g.r - CLEAR, Math.max(c.x + g.r, label.x + label.w) + CLEAR, label.y + label.h + CLEAR, o => distance(c, o.s) >= g.r + CLEAR && !crosses(o.s, label, CLEAR));
      budget -= work;
      return going;
    };
    const dedupe = (points: readonly Point[]) => points.filter((q, i) => !i || Math.abs(q.x - points[i - 1]!.x) > .01 || Math.abs(q.y - points[i - 1]!.y) > .01);
    /**
     * 틈 k에서 레인 x → y로 옮기는 길 후보(싼 것부터) — 한 번의 45° 가지가 틈에 들어가면 그것, 아니면 45°로 갈라져 틈 안을 곧게 내려가고(올라가고)
     * 45°로 레인에 드는 줄기-가지다. 다른 선이 그 세로 줄을 쓰고 있으면 틈 안의 다음 줄로 비킨다. end 는 틈 뒤 이어 갈 x(자식이면 그 가운데)다.
     */
    // 값이 싼 것부터 하나씩 만든다 — 앞의 후보로 정해지면 뒤의 줄은 만들지 않는다.
    function* shifts(k: number, x: number, y: number, end: number, last: boolean): Generator<{ points: Point[]; cost: number }> {
      const span = Math.abs(x - y), dir = Math.sign(y - x), y0 = laneY(x), y1 = laneY(y);
      if (!span) { yield { points: [{ x: gs(k), y: y0 }, { x: end, y: y0 }], cost: 0 }; return; }
      const room = (last ? end : ge(k)) - gs(k);
      if (span * g.laneH <= room + .01) yield { points: [{ x: gs(k), y: y0 }, { x: gs(k) + span * g.laneH, y: y1 }, { x: end, y: y1 }], cost: .5 };
      const half = g.laneH / 2, chamfered = (v: number, c: number) => [{ x: gs(k), y: y0 }, { x: v - c, y: y0 }, { x: v, y: y0 + dir * c }, { x: v, y: y1 - dir * c }, { x: v + c, y: y1 }, { x: end, y: y1 }];
      if (span > 1 && 2 * half <= ge(k) - gs(k) + .01) yield { points: chamfered(gs(k) + half, half), cost: .6 };
      for (let v = gs(k) + CHAMFER, i = 0; v <= ge(k) - CHAMFER + .01; v += TRACK, i++) yield { points: chamfered(v, CHAMFER), cost: .8 + i * .02 };
    }
    interface Way { cost: number; points: Point[] }
    /**
     * 부모에서 자식 열 앞 틈(gs(d))까지 레인별로 가장 싼 길 — 지나는 틈마다 레인을 한 번 바꿀 수 있고, 열은 제 레인을 따라 곧게 지난다.
     * 자식 레인과 무관하므로 자식 레인 후보마다 다시 찾지 않는다. once 면 부모 바로 다음 틈에서만 레인을 바꾼다(이동 레인 하나 — 싸서 먼저 본다).
     */
    const reach = (from: string | null, to: string, d: number, lo: number, hi: number, once: boolean) => {
      const p = at(from), a = from ? depth.get(from)! : -1, lp = from ? lane.get(from)! : 0;
      let ways = new Map<number, Way>();
      const start = dedupe([p, { x: gs(a + 1), y: p.y }]);
      if (ok(start, from, to)) ways.set(lp, { cost: crossings(start, from, to) * CROSS, points: start });
      for (let k = a + 1; k < d; k++) {
        if (budget < 0) return new Map<number, Way>();
        const next = new Map<number, Way>();
        for (const [x, way] of ways) for (let y = lo; y <= hi && budget >= 0; y++) {
          if (once && k > a + 1 && y !== x) continue;
          const base = way.cost + Math.abs(x - y) + (x !== y ? (k - a) * .01 : 0) + (y < 0 ? ABOVE : 0);
          if ((next.get(y)?.cost ?? Infinity) <= base) continue;
          // 틈 안의 길 후보는 싼 것부터 — 엇갈림까지 더한 값이 가장 작은 것을 고른다. 후보 자체 값이 이미 나으면 더 보지 않는다.
          for (const shift of shifts(k, x, y, gs(k + 1), false)) {
            if (budget < 0 || (next.get(y)?.cost ?? Infinity) <= base + shift.cost) break;
            const step = dedupe(shift.points);
            if (!ok(step, from, to)) continue;
            const cost = base + shift.cost + crossings(step, from, to) * CROSS;
            if ((next.get(y)?.cost ?? Infinity) > cost) next.set(y, { cost, points: dedupe([...way.points, ...step.slice(1)]) });
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
        if (budget < 0) break;
        const base = way.cost + Math.abs(x - l);
        if (best && best.cost <= base) continue;
        for (const shift of shifts(d, x, l, c.x, true)) {
          if (budget < 0 || (best && best.cost <= base + shift.cost)) break;
          const step = dedupe(shift.points);
          if (!ok(step, from, to)) continue;
          const cost = base + shift.cost + crossings(step, from, to) * CROSS;
          if (!best || best.cost > cost) best = { cost, points: dedupe([...way.points, ...step.slice(1)]) };
        }
      }
      return best;
    };
    if (keep) {
      for (const m of order) {
        if ((depth.get(m.id) ?? 0) >= upto) break;
        const l = keep.lane.get(m.id)!, c = { x: colX(depth.get(m.id) ?? 0), y: laneY(l) };
        lane.set(m.id, l); last.set(depth.get(m.id) ?? 0, l); addNode({ id: m.id, at: c, r: g.r }); addLabel(labelOf(c));
      }
      for (const e of keep.placed) if ((depth.get(e.to) ?? 0) < upto) { placed.push(e); remember(e); }
    }
    for (const m of order) {
      if (keep && (depth.get(m.id) ?? 0) < upto) continue;
      if (budget < 0) break;
      const d = depth.get(m.id) ?? 0, parents = parentsOf(m), sources: (string | null)[] = parents.length ? parents : [null];
      const sourceLanes = sources.map(from => from ? lane.get(from)! : 0);
      const anchor = Math.min(...sourceLanes);
      // 우회 레인은 뿌리 레인(0) 위로 하나까지 열어 두되(ABOVE 만큼 무겁게) 노드 줄 사이나 아래를 먼저 쓴다 — 위로 돌면 첫 줄 위에 빈 띠가 생긴다.
      const used = [...lane.values(), ...placed.flatMap(e => [e.lo, e.hi]), 0];
      const lo = -1, hi = Math.max(...used) + sources.length + 2;
      // 한 열 안에서는 편성 순서대로 위에서 아래로 선다 — 앞 임무보다 아래 레인만 본다. 노드는 뿌리 레인(0)보다 위로 가지 않는다.
      const floor = (last.get(d) ?? -1) + 1;
      // 노드 레인 비용 — 부모 레인에 가까울수록(합류는 가장 위 부모 쪽) 싸다.
      const nodeCost = (l: number) => Math.abs(l - anchor) * 1.5;
      const candidates = Array.from({ length: Math.max(0, hi - floor + 1) }, (_, i) => floor + i).sort((a, b) => nodeCost(a) - nodeCost(b) || a - b);
      const place = (reaches: readonly ReadonlyMap<number, Way>[]) => {
        let best: { cost: number; l: number; edges: HPlaced[] } | null = null;
        for (const l of candidates) {
          if (budget < 0 || (best && nodeCost(l) >= best.cost)) break;
          const c = { x: colX(d), y: laneY(l) }, label = labelOf(c);
          const near = obstacles.visit(c.x - g.r - CLEAR - 2, c.y - g.r - CLEAR - 2, Math.max(c.x + g.r, label.x + label.w) + CLEAR + 2, label.y + label.h + CLEAR + 2, o => !("label" in o) || !(intersects(o.label, label, 2) || crosses({ a: c, b: c }, o.label, g.r + CLEAR)));
          budget -= near.work;
          if (!roomFor(c) || !near.going) continue;
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
        return best;
      };
      // 이동 레인 하나로 먼저 찾고, 못 찾으면 틈마다 레인을 바꾸는 길까지 넓혀 본다.
      const best = place(sources.map(from => reach(from, m.id, d, lo, hi + 1, true))) ?? (budget < 0 ? null : place(sources.map(from => reach(from, m.id, d, lo, hi + 1, false))));
      // 맞는 자리가 없으면 그 열 앞이 좁은 것이다 — 아래 바깥 레인에 곧은 선으로 두고, 바깥 루프가 그 간격을 넓혀 다시 배정한다.
      const l = best?.l ?? Math.max(floor, hi + 1);
      if (!best) { failed.add(d); stranded.push(m.id); }
      lane.set(m.id, l); last.set(d, l);
      for (const e of best?.edges ?? sources.map(from => ({ from, to: m.id, points: [at(from), at(m.id)], lines: [], lo: Math.min(l, from ? lane.get(from)! : 0), hi: l }))) { placed.push(e); remember(e); }
      const c = at(m.id);
      addNode({ id: m.id, at: c, r: g.r });
      addLabel(labelOf(c));
    }
    return { lane, placed, xs, routed: true, detoured: 0, failed, spent: budget < 0, stranded };
  };
  type Searched = ReturnType<typeof assign>;
  /**
   * 버스 선을 바깥 레인(below 부터)에 묶는다 — 묶음(부모 또는 자식)마다 [가장 이른 나가는 줄, 가장 늦은 드는 줄] 구간을 차지하고, 구간이 안 겹치는
   * 묶음끼리는 한 레인을 나눠 쓴다. 부모마다·자식마다 묶은 것 중 레인이 적게 드는 쪽을 쓴다(같은 부모·같은 자식끼리는 줄기를 함께 쓴다).
   */
  const packBuses = <L extends { from: string | null; to: string }>(buses: readonly L[], departure: (e: L) => number, arrival: (e: L) => number, below: number) => {
    const pack = (keyOf: (e: L) => string) => {
      const spans = new Map<string, { lo: number; hi: number }>();
      for (const e of buses) { const key = keyOf(e), span = spans.get(key) ?? { lo: Infinity, hi: -Infinity }; span.lo = Math.min(span.lo, departure(e)); span.hi = Math.max(span.hi, arrival(e)); spans.set(key, span); }
      const ends: number[] = [], lanes = new Map<string, number>();
      for (const [key, span] of [...spans].sort((a, b) => a[1].lo - b[1].lo)) {
        let k = ends.findIndex(end => end < span.lo - TRACK);
        if (k < 0) { k = ends.length; ends.push(0); }
        ends[k] = span.hi; lanes.set(key, below + k);
      }
      return { lanes, count: ends.length, keyOf };
    };
    const byChild = pack(e => e.to), byParent = pack(e => `\u0001${e.from ?? ""}`), packed = byParent.count < byChild.count ? byParent : byChild;
    return (e: L) => packed.lanes.get(packed.keyOf(e))!;
  };
  /** 버스 선의 꼴 — 부모 레인을 따라 나가는 줄 v 로 가 45°로 내려가 바깥 레인 yb 를 지나, 드는 줄 w 에서 올라 45°로 자식 레인에 든다. */
  const busPoints = (p: Point, c: Point, v: number, w: number, yb: number) => {
    const k = CHAMFER;
    return [p, { x: v - k, y: p.y }, { x: v, y: p.y + k }, { x: v, y: yb - k }, { x: v + k, y: yb }, { x: w - k, y: yb }, { x: w, y: yb - k }, { x: w, y: c.y + k }, { x: w + k, y: c.y }, c];
  };
  /**
   * 부분 버스 배치 — 예산을 다 썼거나 넓혀도 길을 못 찾았을 때, 찾은 선은 그대로 두고 못 찾은 임무와 예산이 다해 못 놓은 임무로 드는 선만 버스로 그린다.
   * - 못 놓은 임무는 제 열에서 앞 임무보다 아래, 그은 모든 레인과 선보다 아래의 새 레인에 선다. 새 레인의 같은 레인 부모·자식은 사이 열에 노드가 없으면 곧게 잇는다.
   * - 나머지는 버스 선이다. 나가는 줄·드는 줄은 틈의 시작(gs)에 새로 낸 띠에 서고, 띠 폭만큼 그 오른쪽의 열과 선을 민다. 찾은 선은 gs 를 가로로만
   *   지나므로(열 안은 제 레인을 따라 곧게, 틈의 가지는 gs 에서 시작한다) 민 뒤에도 45°와 비킴이 그대로다. 띠 안에는 노드·이름과 다른 선의 세로·사선
   *   조각이 없어 세로 줄은 가로선과 엇갈리기만 하고, 띠 안의 줄 순서는 버스 배치와 같다([나가는 줄 | 드는 줄]).
   * - 버스 선의 가로 끝(부모에서 나가는 줄까지, 드는 줄에서 자식까지)을 다른 선이 같은 줄로 겹쳐 가면 null — 전체 버스 배치로 간다. 뿌리에서 드는(0열) 선도
   *   null 이다 — 뿌리 틈의 가지는 뿌리 가운데서 시작해 띠를 낼 자리가 없다.
   */
  const partial = (run: Searched): HAssigned | null => {
    const lane = new Map(run.lane), fresh = new Set<string>(), stranded = new Set(run.stranded);
    const routed = run.placed.filter(e => !stranded.has(e.to));
    const base = Math.max(0, ...lane.values(), ...routed.map(e => e.hi)) + 1, last = new Map<number, number>();
    for (const m of order) {
      const d = depth.get(m.id) ?? 0;
      if (!lane.has(m.id)) { lane.set(m.id, Math.max(base, (last.get(d) ?? -1) + 1)); fresh.add(m.id); stranded.add(m.id); }
      last.set(d, lane.get(m.id)!);
    }
    const colOf = (id: string | null) => id ? depth.get(id) ?? 0 : -1, laneOf = (id: string | null) => id ? lane.get(id)! : 0;
    const links = order.filter(m => stranded.has(m.id)).flatMap(m => { const parents = parentsOf(m); return (parents.length ? parents : [null]).map(from => ({ from, to: m.id, straight: false })); });
    if (links.some(e => e.from === null || colOf(e.from) >= colOf(e.to))) return null;
    const occupied = new Set([...lane].map(([id, l]) => `${depth.get(id) ?? 0}\u0001${l}`));
    for (const e of links) {
      if (!e.from || !fresh.has(e.from) || !fresh.has(e.to) || laneOf(e.from) !== laneOf(e.to)) continue;
      let open = true;
      for (let k = colOf(e.from) + 1; k < colOf(e.to) && open; k++) open = !occupied.has(`${k}\u0001${laneOf(e.to)}`);
      e.straight = open;
    }
    const buses = links.filter(e => !e.straight);
    const gsOld = (k: number) => run.xs[k - 1]! - g.r + labelW + CLEAR;
    // 버스 선의 가로 끝이 찾은 선과 같은 줄로 겹치는지 — 찾은 선 가운데 같은 부모·같은 자식이 아닌 것의 가로 조각만 본다.
    const flats = routed.flatMap(e => segments(e.points).filter(s => Math.abs(s.a.y - s.b.y) < .01).map(s => ({ from: e.from, to: e.to, y: s.a.y, lo: Math.min(s.a.x, s.b.x), hi: Math.max(s.a.x, s.b.x) })));
    const taken = (from: string | null, to: string, y: number, lo: number, hi: number) => flats.some(f => f.from !== from && f.to !== to && Math.abs(f.y - y) < 2 && f.hi > lo + 1 && f.lo < hi - 1);
    for (const e of buses) {
      const p = { x: run.xs[colOf(e.from)]!, y: laneY(laneOf(e.from)) }, c = { x: run.xs[colOf(e.to)]!, y: laneY(laneOf(e.to)) };
      if (taken(e.from, e.to, p.y, p.x, gsOld(colOf(e.from) + 1) + 2) || taken(e.from, e.to, c.y, gsOld(colOf(e.to)) - 2, c.x)) return null;
    }
    // 띠 — 틈 k 마다 [나가는 줄(아래 레인 부모가 왼쪽) | 드는 줄(위 레인 자식이 왼쪽)]. add[k] 는 k열(과 그 앞 틈의 gs 오른쪽)이 밀리는 거리다.
    const outs = Array.from({ length: cols }, () => new Set<string>()), ins = Array.from({ length: cols }, () => new Set<string>());
    for (const e of buses) { outs[colOf(e.from) + 1]!.add(e.from!); ins[colOf(e.to)]!.add(e.to); }
    const out = new Map<string, number>(), into = new Map<string, number>(), add: number[] = [0];
    for (let k = 1; k < cols; k++) {
      const start = gsOld(k) + add[k - 1]!;
      let x = start;
      const o = [...outs[k]!].sort((a, b) => laneOf(b) - laneOf(a)), i = [...ins[k]!].sort((a, b) => laneOf(a) - laneOf(b));
      o.forEach((from, j) => out.set(from, x + CHAMFER + j * TRACK));
      if (o.length) x += CHAMFER + (o.length - 1) * TRACK + CHAMFER + TRACK;
      i.forEach((id, j) => into.set(id, x + CHAMFER + j * TRACK));
      if (i.length) x += CHAMFER + (i.length - 1) * TRACK + CHAMFER + TRACK;
      add.push(add[k - 1]! + x - start);
    }
    const xs = run.xs.map((x, k) => x + add[k]!);
    const move = (p: Point) => { let k = 0; while (k + 1 < cols && gsOld(k + 1) <= p.x + 1e-6) k++; return { x: p.x + add[k]!, y: p.y }; };
    const at = (id: string | null) => id ? { x: xs[colOf(id)]!, y: laneY(laneOf(id)) } : { x: rootX, y: 0 };
    const below = Math.max(...lane.values(), ...routed.map(e => e.hi)) + 1;
    const busLane = packBuses(buses, e => out.get(e.from!)!, e => into.get(e.to)!, below);
    const placed: HPlaced[] = [
      ...routed.map(e => ({ ...e, points: e.points.map(move), lines: [] })),
      ...links.map((e): HPlaced => e.straight
        ? { from: e.from, to: e.to, points: [at(e.from), at(e.to)], lines: [], lo: laneOf(e.to), hi: laneOf(e.to) }
        : { from: e.from, to: e.to, points: busPoints(at(e.from), at(e.to), out.get(e.from!)!, into.get(e.to)!, laneY(busLane(e))), lines: [], lo: Math.min(laneOf(e.from), laneOf(e.to)), hi: busLane(e) }),
    ];
    return { lane, placed, xs, routed: true, detoured: links.length };
  };
  /**
   * 보장된 버스 배치 — 탐색이 예산을 다 썼거나 넓혀도 길을 못 찾을 때 쓴다. 겹침을 검사하지 않고 구조로 비킨다. 열마다 임무를 편성 순서대로 0레인부터 쌓는다.
   * - 곧은 선: 부모와 자식이 같은 레인이고 사이 열의 그 레인이 비어 있으면 제 레인을 따라 곧게 잇는다(그 레인·틈을 지나는 다른 선이 구조상 없다).
   * - 이웃 열 가지: 바로 옆 열로 레인을 바꾸는 선은 틈 가운데의 제 세로 줄에서 45°로 갈라져(한 레인이면 45° 한 번) 든다. 레인 X 에서 나가는 선이
   *   레인 X 로 드는 선보다 왼쪽에 서서 제 레인의 곧은 선끼리 겹치지 않는다. 그 순서가 돌면 그중 하나는 버스로 간다.
   * - 버스: 나머지는 노드 아래 바깥 레인을 따라간다 — 부모 다음 틈의 나가는 줄로 내려가 바깥 레인을 지나 자식 앞 틈의 드는 줄로 올라 든다. 바깥 레인은
   *   부모마다 또는 자식마다 하나(같은 부모·같은 자식끼리는 줄기를 함께 쓴다) 중 레인이 적게 드는 쪽으로 묶고, x 구간이 안 겹치면 나눠 쓴다.
   * 틈의 세로 줄은 [나가는 줄 | 이웃 열 가지 | 드는 줄] 순이고, 나가는 줄은 아래 레인 부모가, 드는 줄은 위 레인 자식이 왼쪽에 선다.
   */
  const bus = (): HAssigned => {
    const lane = new Map<string, number>(), stack = new Map<number, number>();
    for (const m of order) { const d = depth.get(m.id) ?? 0, l = stack.get(d) ?? 0; lane.set(m.id, l); stack.set(d, l + 1); }
    const laneOf = (id: string | null) => id ? lane.get(id)! : 0, colOf = (id: string | null) => id ? depth.get(id)! : -1;
    type Link = { from: string | null; to: string; kind: "straight" | "direct" | "bus" };
    const links: Link[] = order.flatMap(m => { const parents = parentsOf(m); return (parents.length ? parents : [null]).map(from => ({ from, to: m.id, kind: "bus" as Link["kind"] })); });
    const occupied = new Set(order.map(m => `${depth.get(m.id)}\u0001${lane.get(m.id)}`));
    for (const e of links) {
      const a = colOf(e.from), d = colOf(e.to), l = laneOf(e.to);
      if (laneOf(e.from) === l) { let open = true; for (let k = a + 1; k < d && open; k++) open = !occupied.has(`${k}\u0001${l}`); if (open) { e.kind = "straight"; continue; } }
      if (d === a + 1) e.kind = "direct";
    }
    const direct: Link[][] = [];
    for (let k = 0; k < cols; k++) {
      // 레인마다 아직 줄을 못 받은 '나가는' 선의 수를 세어, 0인 레인으로 드는 선부터 줄을 준다. 막히면(순서가 돌면) 가장 멀리 건너는 선을 버스로 보낸다.
      const rest = new Set(links.filter(e => e.kind === "direct" && colOf(e.to) === k)), leaving = new Map<number, number>();
      for (const e of rest) leaving.set(laneOf(e.from), (leaving.get(laneOf(e.from)) ?? 0) + 1);
      const ordered: Link[] = [];
      const take = (e: Link) => { rest.delete(e); leaving.set(laneOf(e.from), leaving.get(laneOf(e.from))! - 1); };
      while (rest.size) {
        let moved = false;
        for (const e of rest) if (!leaving.get(laneOf(e.to))) { ordered.push(e); take(e); moved = true; }
        if (moved) continue;
        let drop: Link | null = null;
        for (const e of rest) if (!drop || Math.abs(laneOf(e.to) - laneOf(e.from)) > Math.abs(laneOf(drop.to) - laneOf(drop.from))) drop = e;
        drop!.kind = "bus"; take(drop!);
      }
      direct.push(ordered);
    }
    const buses = links.filter(e => e.kind === "bus");
    const gapOf = (from: string | null) => colOf(from) + 1;
    const outs = Array.from({ length: cols }, () => new Set<string | null>()), ins = Array.from({ length: cols }, () => new Set<string>());
    for (const e of buses) { outs[gapOf(e.from)]!.add(e.from); ins[colOf(e.to)]!.add(e.to); }
    const half = g.laneH / 2, xs: number[] = [], out = new Map<string, number>(), into = new Map<string, number>(), mid = new Map<Link, number>();
    for (let k = 0; k < cols; k++) {
      let x = k ? xs[k - 1]! - g.r + labelW + CLEAR : rootX + g.rootR + CLEAR;
      const o = [...outs[k]!].sort((a, b) => laneOf(b) - laneOf(a)), i = [...ins[k]!].sort((a, b) => laneOf(a) - laneOf(b));
      o.forEach((from, j) => out.set(`${k}\u0001${from ?? ""}`, x + CHAMFER + j * TRACK));
      if (o.length) x += CHAMFER + (o.length - 1) * TRACK + CHAMFER + TRACK;
      direct[k]!.forEach((e, j) => mid.set(e, x + half + j * TRACK));
      if (direct[k]!.length) x += half + (direct[k]!.length - 1) * TRACK + half + TRACK;
      i.forEach((id, j) => into.set(id, x + CHAMFER + j * TRACK));
      if (i.length) x += CHAMFER + (i.length - 1) * TRACK + CHAMFER;
      xs.push(Math.max(x + g.r + CLEAR + 4, k ? xs[k - 1]! + colGap(labelW) : rootX + rootGap));
    }
    const departure = (from: string | null) => out.get(`${gapOf(from)}\u0001${from ?? ""}`)!;
    const busLane = packBuses(buses, e => departure(e.from), e => into.get(e.to)!, Math.max(0, ...lane.values()) + 1);
    const at = (id: string | null) => id ? { x: xs[depth.get(id)!]!, y: laneY(laneOf(id)) } : { x: rootX, y: 0 };
    const placed = links.map((e): HPlaced => {
      const p = at(e.from), c = at(e.to);
      if (e.kind === "straight") return { from: e.from, to: e.to, points: [p, c], lines: [], lo: laneOf(e.to), hi: laneOf(e.to) };
      if (e.kind === "direct") {
        const u = mid.get(e)!, dir = Math.sign(c.y - p.y);
        const points = [p, { x: u - half, y: p.y }, { x: u, y: p.y + dir * half }, { x: u, y: c.y - dir * half }, { x: u + half, y: c.y }, c];
        return { from: e.from, to: e.to, points: points.filter((q, i) => !i || Math.abs(q.x - points[i - 1]!.x) > .01 || Math.abs(q.y - points[i - 1]!.y) > .01), lines: [], lo: Math.min(laneOf(e.from), laneOf(e.to)), hi: Math.max(laneOf(e.from), laneOf(e.to)) };
      }
      return { from: e.from, to: e.to, points: busPoints(p, c, departure(e.from), into.get(e.to)!, laneY(busLane(e))), lines: [], lo: Math.min(laneOf(e.from), laneOf(e.to)), hi: busLane(e) };
    });
    return { lane, placed, xs, routed: false, detoured: links.length };
  };
  // 비킬 자리가 없으면 그 열 앞의 간격을 한 레인씩 넓혀 다시 배정한다 — 예산 안에서만. 예산을 다 쓰거나 끝내 못 찾으면 찾은 선은 두고 나머지만 버스로
  // 그리고(partial), 그것도 못 하면 전체를 버스 배치로 그린다.
  const cacheKey = `${wide}\u0003${labelW}\u0003${shape}`;
  let run: HAssigned | undefined = hAssigned.get(cacheKey);
  if (run) { hAssigned.delete(cacheKey); hAssigned.set(cacheKey, run); }
  else {
    const gaps = Array.from({ length: cols }, (_, d) => d ? colGap(labelW) : rootGap);
    let tried = assign(gaps);
    for (let k = 0; k < WIDEN_LIMIT && tried.failed.size && !tried.spent; k++) {
      for (const d of tried.failed) gaps[d]! += g.laneH;
      tried = assign(gaps, tried, Math.min(...tried.failed));
    }
    run = tried.failed.size || tried.spent ? partial(tried) ?? bus() : tried;
    if (hAssigned.size >= ASSIGNED_LIMIT) hAssigned.delete(hAssigned.keys().next().value!);
    hAssigned.set(cacheKey, run);
  }
  const final: HAssigned = run, colX = (d: number) => final.xs[d]!;
  const laneSet = [0, ...final.lane.values(), ...final.placed.flatMap(e => [e.lo, e.hi])];
  const minLane = Math.min(...laneSet), maxLane = Math.max(...laneSet);
  // 맨 윗레인 위로는 노드 표식(r+7)과, 뿌리가 맨 위면 그 위의 지휘관 이름 칸이 들어갈 여백을 둔다.
  const top = Math.max(g.r + 10, minLane === 0 ? g.rootR + 22 : 0) - laneY(minLane);
  const shift = (p: Point) => ({ x: p.x, y: p.y + top });
  const pos = new Map<string, Point>([...final.lane].map(([id, l]) => [id, shift({ x: colX(depth.get(id) ?? 0), y: laneY(l) })]));
  const root = shift({ x: rootX, y: 0 });
  const edges: GraphEdge[] = final.placed.map(e => ({ from: e.from, to: e.to, d: roundedPath(e.points.map(shift), 6) }));
  const labels = new Map<string, Rect>([...pos].map(([id, p]) => [id, { x: p.x - g.r, y: p.y + labelDy, w: labelW, h: labelH }]));
  const rootLabel: Rect = { x: root.x - g.rootR, y: root.y - g.rootR - 18, w: ROOT_LABEL_W, h: 14 };
  const right = Math.max(rootX - g.rootR + ROOT_LABEL_W, ...[...labels.values()].map(l => l.x + l.w));
  const height = laneY(maxLane) + top + labelDy + labelH + 8;
  return { g, pos, root, rootLabel, edges, labels, routed: final.routed, detoured: final.detoured, width: Math.max(width, Math.ceil(right + g.pad)), height: Math.ceil(height) };
}

export type HorizontalLayout = ReturnType<typeof horizontalLayout>;
