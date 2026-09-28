import { missionDepths, type ObjectiveMission } from "../server/types.js";

export interface Point { x: number; y: number }
export interface Rect extends Point { w: number; h: number }
interface Label extends Rect { lines: string[]; shown: number; full: boolean }
export interface GraphEdge { from: string | null; to: string; d: string; points: Point[] }
export const intersects = (a: Rect, b: Rect, pad = 0) => a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
const inside = (p: Point, r: Rect, pad = 0) => p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;
const bezier = (a: number, b: number, c: number, d: number, t: number) => (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d;
export function edgeGeometry(a: Point, b: Point) {
  const k = Math.max(10, (b.x - a.x) / 2);
  return { d: `M${a.x},${a.y} C${a.x + k},${a.y} ${b.x - k},${b.y} ${b.x},${b.y}`, points: Array.from({ length: 60 }, (_, i) => ({ x: bezier(a.x, a.x + k, b.x - k, b.x, i / 59), y: bezier(a.y, a.y, b.y, b.y, i / 59) })) };
}
function ellipsize(text: string, width: number, count: number, measure: (value: string) => number) {
  const chars = [...text], lines: string[] = [];
  let current = "", i = 0;
  for (; i < chars.length; i++) {
    const c = chars[i]!;
    if (!current && c === " ") continue;
    if (measure(current + c) > width && current) { lines.push(current); current = ""; if (lines.length === count) break; if (c === " ") continue; }
    current += c;
  }
  if (lines.length < count && current) { lines.push(current); i = chars.length; }
  const full = i >= chars.length;
  if (!full && lines.length) {
    let last = lines.at(-1)!;
    while (last && measure(last + "…") > width) last = [...last].slice(0, -1).join("");
    lines[lines.length - 1] = last.trimEnd() + "…";
  }
  return { lines, full, shown: lines.join("").replace(/[ …]/g, "").length, w: Math.max(0, ...lines.map(measure)) };
}

/** 승인 v3의 깊이 열·충돌 회피 이름 배치. 공간이 부족하면 글자를 없애지 않고 캔버스를 넓힌다. */
export function graphLayout(missions: readonly ObjectiveMission[], width: number, wide: boolean, measure: (value: string) => number, commander: string, extra = 0) {
  const g = wide ? { r: 12, lfs: 12, llh: 16, lines: 1, rootX: 26, x0: 96, right: 70, capW: 210, minCol: 96 } : { r: 11, lfs: 11, llh: 14, lines: 2, rootX: 16, x0: 54, right: 30, capW: 110, minCol: 58 };
  const depth = missionDepths(missions);
  const cols = missions.length ? Math.max(...missions.map(m => depth.get(m.id) ?? 0)) + 1 : 1;
  const colW = cols > 1 ? Math.max(g.minCol + extra, (width - g.x0 - g.right) / (cols - 1)) : 0;
  const canvasWidth = Math.max(width, g.x0 + Math.max(0, cols - 1) * colW + g.right);
  const byCol = new Map<number, string[]>();
  for (const m of missions) { const d = depth.get(m.id) ?? 0; byCol.set(d, [...(byCol.get(d) ?? []), m.id]); }
  const rows = Math.max(1, ...[...byCol.values()].map(v => v.length));
  const rowH = Math.max(wide ? 60 : 56, Math.min(78, (wide ? 390 : width >= 350 ? 290 : 340) / Math.max(1, rows - 1)));
  const top = g.lines * g.llh + g.r + 14;
  const pos = new Map<string, Point & { col: number }>();
  for (const [col, ids] of byCol) ids.forEach((id, i) => pos.set(id, { x: cols > 1 ? g.x0 + col * colW : (g.x0 + canvasWidth - g.right) / 2, y: top + i * rowH + (rows - ids.length) * rowH / 2, col }));
  const root = { x: g.rootX, y: top + (rows - 1) * rowH / 2 };
  const edges: GraphEdge[] = [];
  for (const m of missions) {
    const p = pos.get(m.id)!;
    const parents = m.prerequisites.filter(id => pos.has(id));
    if (!parents.length) edges.push({ from: null, to: m.id, ...edgeGeometry({ x: root.x + 6, y: root.y }, { x: p.x - g.r - 1, y: p.y }) });
    for (const id of parents) { const q = pos.get(id)!; edges.push({ from: id, to: m.id, ...edgeGeometry({ x: q.x + g.r + 1, y: q.y }, { x: p.x - g.r - 1, y: p.y }) }); }
  }
  const nodeRects = [...pos.values()].map(p => ({ x: p.x - g.r - 4, y: p.y - g.r - 7, w: 2 * g.r + 8, h: 2 * g.r + 17 }));
  nodeRects.push({ x: root.x - 8, y: root.y - 8, w: 16, h: 16 });
  const rootLabel = { x: Math.max(0, root.x - measure(commander) / 2), y: root.y + 10, w: measure(commander), h: 13, lines: [commander] };
  const samples = edges.flatMap(e => e.points);
  const maxWidth = Math.min(g.capW + extra, cols > 1 ? colW * 1.9 - 10 : canvasWidth - 40);
  const branches = (m: ObjectiveMission) => {
    const p = pos.get(m.id)!; let up = 0, down = 0;
    for (const e of edges) {
      if (e.to !== m.id && e.from !== m.id) continue;
      const q = e.to === m.id ? (e.from ? pos.get(e.from)! : root) : pos.get(e.to)!;
      if (q.y < p.y - 2) up++; else if (q.y > p.y + 2) down++;
    }
    return { up, down, difficulty: (up && down ? 10 : 0) + up + down };
  };
  const place = (order: readonly ObjectiveMission[]) => {
    const occupied: Rect[] = [rootLabel], labels = new Map<string, Label>();
    for (const m of order) {
      const p = pos.get(m.id)!, { up, down } = branches(m);
      const preferred = up < down ? "above" : down < up ? "below" : p.col % 2 === 0 ? "above" : "below";
      let best: (Label & { score: number }) | null = null;
      for (const side of [preferred, preferred === "above" ? "below" : "above"]) for (const factor of [1, .84, .7, .58, .46, .36]) for (const count of g.lines > 1 ? [g.lines, 1] : [1]) {
        const label = ellipsize(m.text, maxWidth * factor, count, measure), w = Math.ceil(label.w) + 2, h = label.lines.length * g.llh;
        for (const dx of [0, -.3, .3, "L", "R", -.46, .46]) {
          const x = dx === "L" ? p.x - g.r + 1 : dx === "R" ? p.x + g.r - 1 - w : p.x - w / 2 + (dx as number) * w;
          const y = side === "above" ? p.y - g.r - 9 - h : p.y + g.r + 12, r = { x, y, w, h };
          if (x < 4 || x + w > canvasWidth - 4 || nodeRects.some(n => intersects(r, n, 1)) || occupied.some(l => intersects(r, l, 3)) || samples.some(s => inside(s, r, 2))) continue;
          const center = { x: x + w / 2, y: y + h / 2 }, own = Math.hypot(p.x - center.x, p.y - center.y);
          if ([...pos].some(([id, q]) => id !== m.id && Math.hypot(q.x - center.x, q.y - center.y) < own + 2)) continue;
          const score = label.shown * 10 + (side === preferred ? 3 : 0) + (dx === 0 ? 2 : 0) - (typeof dx === "number" ? Math.abs(dx) * 2 : 1.2) - w * .01 - count * .5;
          if (!best || score > best.score) best = { ...label, ...r, score };
        }
      }
      if (best) { labels.set(m.id, best); occupied.push(best); }
    }
    return { labels, score: missions.reduce((sum, m) => { const l = labels.get(m.id); return sum + (l ? (l.full ? 1000 : 0) + l.shown : -5000); }, 0) };
  };
  let order = [...missions].sort((a, b) => branches(b).difficulty - branches(a).difficulty), best = place(order);
  for (let k = 0; k < 5; k++) {
    const weak = order.filter(m => !best.labels.get(m.id)?.full);
    if (!weak.length) break;
    order = [...weak, ...order.filter(m => !weak.includes(m))];
    const run = place(order); if (run.score > best.score) best = run;
  }
  // 같은 짧은 접두사로 합쳐지는 이름과 사라진 이름에는 폭을 양보한다. 번호는 늘 별도로 유지한다.
  const shortNames = [...best.labels.values()].filter(l => !l.full && l.shown < 8).map(l => l.lines.join(""));
  if (extra < 64 && (best.labels.size < missions.length || new Set(shortNames).size < shortNames.length)) return graphLayout(missions, width, wide, measure, commander, extra + 16);
  const minY = Math.min(...[...pos.values()].map(p => p.y - g.r - 8), ...[...best.labels.values()].map(l => l.y), rootLabel.y, root.y - 10);
  const maxY = Math.max(...[...pos.values()].map(p => p.y + g.r + 11), ...[...best.labels.values()].map(l => l.y + l.h), rootLabel.y + rootLabel.h);
  const dy = 4 - minY;
  pos.forEach(p => { p.y += dy; }); root.y += dy; rootLabel.y += dy; best.labels.forEach(l => { l.y += dy; });
  for (const e of edges) Object.assign(e, edgeGeometry({ x: e.points[0]!.x, y: e.points[0]!.y + dy }, { x: e.points[59]!.x, y: e.points[59]!.y + dy }));
  return { width: canvasWidth, height: Math.round(maxY + dy + 4), g, pos, root, rootLabel, edges, labels: best.labels, colW, cols };
}
