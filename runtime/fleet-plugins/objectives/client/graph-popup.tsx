import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { intersects, type Rect } from "./graph-layout.js";

export interface PopupAnchor { node: HTMLElement; label?: HTMLElement | null }
const rect = (r: DOMRect): Rect => ({ x: r.left, y: r.top, w: r.width, h: r.height });

/** 같은 DOM과 크기를 호버·고정에서 공유한다. 위치는 노드와 별개 층이므로 그래프를 밀지 않는다. */
export function GraphPopup({ id, anchor, boundary, pinned, closing, hidden, label, children, onKeep, onMove, onLeave, onPin, onEscape }: {
  id: string; anchor: PopupAnchor; boundary: HTMLElement; pinned: boolean; closing: boolean; hidden: boolean; label: string; children: ReactNode;
  onKeep: () => void; onMove: (event: React.PointerEvent) => void; onLeave: () => void; onPin: () => void; onEscape: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [links, setLinks] = useState<{ d: string; down: boolean }[]>([]);
  const clipId = `${id}-links`;
  const [position, setPosition] = useState<{ x: number; y: number; width: number; height: number; side: string; tail: number } | null>(null);
  useLayoutEffect(() => {
    const pop = ref.current;
    if (!pop) return;
    const place = () => {
      if (!anchor.node.isConnected) return;
      const nb = rect(anchor.node.getBoundingClientRect());
      const self = [nb, ...(anchor.label ? [rect(anchor.label.getBoundingClientRect())] : [])];
      const bb = boundary.getBoundingClientRect();
      const left = Math.max(8, bb.left + 4), right = Math.min(innerWidth - 8, bb.right - 4);
      const top = 8, bottom = innerHeight - 8;
      const width = Math.min(bb.width >= 700 ? 300 : 280, right - left);
      pop.style.width = `${width}px`;
      const full = Math.min((pop.querySelector<HTMLElement>(".objectives-popup-body")?.scrollHeight ?? pop.scrollHeight) + 22, 490);
      const others = [...boundary.querySelectorAll<HTMLElement>("[data-graph-node]")].filter(n => n !== anchor.node).map(n => rect(n.getBoundingClientRect()));
      const minX = Math.min(...self.map(r => r.x)), maxX = Math.max(...self.map(r => r.x + r.w));
      const minY = Math.min(...self.map(r => r.y)), maxY = Math.max(...self.map(r => r.y + r.h));
      const cx = nb.x + nb.w / 2, cy = nb.y + nb.h / 2;
      const candidates: { x: number; y: number; width: number; height: number; side: string; tail: number; score: number }[] = [];
      for (const side of ["right", "left", "below", "above"]) {
        const room = side === "below" ? bottom - maxY - 6 : side === "above" ? minY - 6 - top : bottom - top;
        for (const scale of [1, .75, .55]) {
          const height = Math.min(full * scale, room);
          if (height < Math.min(full, 120)) continue;
          const x0 = side === "right" ? maxX + 6 : side === "left" ? minX - width - 6 : Math.max(left, Math.min(cx - width / 2, right - width));
          const y0 = side === "below" ? maxY + 6 : side === "above" ? minY - height - 6 : Math.max(top, Math.min(cy - height / 2, bottom - height));
          for (const offset of [0, -32, 32, -64, 64]) {
            const x = side === "below" || side === "above" ? Math.max(left, Math.min(x0 + offset, right - width)) : x0;
            const y = side === "left" || side === "right" ? Math.max(top, Math.min(y0 + offset, bottom - height)) : y0;
            const r = { x, y, w: width, h: height };
            if (x < left || x + width > right || y < top || y + height > bottom || self.some(s => intersects(r, s, 2))) continue;
            const horizontal = side === "below" || side === "above";
            if (horizontal ? cx < x + 10 || cx > x + width - 10 : cy < y + 10 || cy > y + height - 10) continue;
            const score = others.filter(o => intersects(r, o)).length * 1000 + (1 - scale) * 900 + candidates.length * .001;
            candidates.push({ x, y, width, height, side, tail: horizontal ? cx - x : cy - y, score });
          }
        }
      }
      candidates.sort((a, b) => a.score - b.score);
      const best = candidates[0];
      if (best) {
        setPosition(old => old && ["x", "y", "width", "height", "tail", "side"].every(k => old[k as keyof typeof old] === best[k as keyof typeof best]) ? old : best);
        // 팝업 위에서 대상 선을 이어 그리되, 본문 대신 안쪽 여백을 따라 우회하여 글자를 가로지르지 않는다.
        const nodeId = anchor.node.dataset.graphNode;
        const paths = [...boundary.querySelectorAll<SVGPathElement>(".objectives-graph-edge")].filter(e => e.dataset.from === nodeId || e.dataset.to === nodeId);
        const next = paths.map(path => {
          const matrix = path.getScreenCTM(), length = path.getTotalLength();
          if (!matrix) return { d: "", down: false };
          const points = Array.from({ length: 121 }, (_, i) => { const q = path.getPointAtLength(length * i / 120).matrixTransform(matrix); return { x: q.x, y: q.y }; });
          const l = best.x + 5, r = best.x + width - 5, t = best.y + 5, b = best.y + best.height - 5;
          const inside = (p: { x: number; y: number }) => p.x > l && p.x < r && p.y > t && p.y < b;
          const first = points.findIndex(inside), last = points.findLastIndex(inside);
          if (first >= 0) {
            const w = r - l, h = b - t, perimeter = 2 * (w + h);
            const project = (p: { x: number; y: number }) => {
              const distances = [Math.abs(p.y - t), Math.abs(p.x - r), Math.abs(p.y - b), Math.abs(p.x - l)];
              const side = distances.indexOf(Math.min(...distances));
              return side === 0 ? p.x - l : side === 1 ? w + p.y - t : side === 2 ? w + h + r - p.x : 2 * w + h + b - p.y;
            };
            const at = (s: number) => { s = (s % perimeter + perimeter) % perimeter; return s < w ? { x: l + s, y: t } : s < w + h ? { x: r, y: t + s - w } : s < 2 * w + h ? { x: r - (s - w - h), y: b } : { x: l, y: b - (s - 2 * w - h) }; };
            const start = project(points[first]!), end = project(points[last]!), forward = (end - start + perimeter) % perimeter;
            const delta = forward <= perimeter / 2 ? forward : forward - perimeter;
            const steps = Math.max(2, Math.ceil(Math.abs(delta) / 3));
            const detour = Array.from({ length: steps }, (_, i) => at(start + delta * i / (steps - 1)));
            points.splice(first, last - first + 1, ...detour);
          }
          return { d: points.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" "), down: path.dataset.from === nodeId };
        });
        setLinks(old => JSON.stringify(old) === JSON.stringify(next) ? old : next);
      }
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(pop); observer.observe(boundary); observer.observe(anchor.node);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); document.removeEventListener("scroll", place, true); };
  }, [anchor.node, anchor.label, boundary]);
  return createPortal(<><div ref={ref} id={id} role="dialog" aria-label={label} data-graph-popup data-side={position?.side} className={`objectives-graph-popup${pinned ? " is-pinned" : ""}${closing ? " is-closing" : ""}`} style={{ left: position?.x ?? 0, top: position?.y ?? 0, width: position?.width ?? 280, maxHeight: position?.height ?? 490, visibility: !position || hidden ? "hidden" : undefined }} onPointerEnter={onKeep} onPointerMove={onMove} onPointerLeave={onLeave} onPointerDown={onPin} onFocus={onKeep} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onEscape(); } }}>
    <span className={`objectives-popup-tail is-${position?.side ?? "below"}`} style={position?.side === "left" || position?.side === "right" ? { top: position.tail } : { left: position?.tail ?? 20 }} />
    <div className="objectives-popup-body" style={{ maxHeight: position ? position.height - 22 : 468 }}>{children}</div>
  </div>{position && !hidden && !closing ? <svg className="objectives-popup-links" aria-hidden="true"><defs><clipPath id={clipId}><rect x={position.x} y={position.y} width={position.width} height={position.height} rx={8} /></clipPath></defs><g clipPath={`url(#${clipId})`}>{links.map((link, i) => <path key={i} d={link.d} className={link.down ? "is-down" : undefined} />)}</g></svg> : null}</>, boundary.closest(".objectives-zoom") ?? document.body);
}
