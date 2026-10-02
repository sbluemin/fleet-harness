import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { intersects, type Rect } from "./graph-layout.js";

const rect = (r: DOMRect): Rect => ({ x: r.left, y: r.top, w: r.width, h: r.height });

/** 같은 DOM과 크기를 호버·고정에서 공유한다. 위치는 노드와 별개 층이므로 그래프를 밀지 않는다. */
export function GraphPopup({ id, missionId, layout, boundary, pinned, closing, focus, hidden, label, children, onKeep, onMove, onLeave, onPin, onEscape, onAnchorLeave }: {
  id: string; missionId: string; layout: object; boundary: HTMLElement; pinned: boolean; closing: boolean; focus: boolean; hidden: boolean; label: string; children: ReactNode;
  onKeep: () => void; onMove: (event: React.PointerEvent) => void; onLeave: () => void; onPin: () => void; onEscape: () => void; onAnchorLeave: (container: HTMLElement) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onAnchorLeaveRef = useRef(onAnchorLeave); onAnchorLeaveRef.current = onAnchorLeave;
  const [links, setLinks] = useState<{ d: string; down: boolean }[]>([]);
  const clipId = `${id}-links`;
  const [position, setPosition] = useState<{ x: number; y: number; width: number; height: number; side: string; tail: number } | null>(null);
  useLayoutEffect(() => {
    const pop = ref.current;
    // 완료·잇기로 미분류와 본 그래프 사이를 옮기면 같은 임무의 DOM이 교체된다.
    // 렌더 중의 옛 요소 대신, 배치가 커밋된 뒤 안정된 임무 id로 앵커를 다시 찾는다.
    const node = boundary.querySelector<HTMLElement>(`[data-graph-node="${CSS.escape(missionId)}"]`);
    const name = boundary.querySelector<HTMLElement>(`[data-graph-label="${CSS.escape(missionId)}"]`);
    if (!pop || !node) { setPosition(null); return; }
    const ancestors: HTMLElement[] = [];
    for (let parent = node.parentElement; parent; parent = parent.parentElement) ancestors.push(parent);
    const place = () => {
      if (!node.isConnected) { setPosition(null); return; }
      const nb = rect(node.getBoundingClientRect());
      let visibleLeft = 0, visibleRight = innerWidth, visibleTop = 0, visibleBottom = innerHeight;
      for (const ancestor of ancestors) {
        const style = getComputedStyle(ancestor);
        if (style.display === "contents") continue;
        const clipX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX), clipY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
        if (!clipX && !clipY) continue;
        const bounds = ancestor.getBoundingClientRect();
        const sx = ancestor.offsetWidth ? bounds.width / ancestor.offsetWidth : 1, sy = ancestor.offsetHeight ? bounds.height / ancestor.offsetHeight : 1;
        if (clipX) { visibleLeft = Math.max(visibleLeft, bounds.left + ancestor.clientLeft * sx); visibleRight = Math.min(visibleRight, bounds.left + (ancestor.clientLeft + ancestor.clientWidth) * sx); }
        if (clipY) { visibleTop = Math.max(visibleTop, bounds.top + ancestor.clientTop * sy); visibleBottom = Math.min(visibleBottom, bounds.top + (ancestor.clientTop + ancestor.clientHeight) * sy); }
      }
      if (nb.x + nb.w <= visibleLeft || nb.x >= visibleRight || nb.y + nb.h <= visibleTop || nb.y >= visibleBottom || visibleLeft >= visibleRight || visibleTop >= visibleBottom) {
        onAnchorLeaveRef.current(boundary.closest<HTMLElement>(".objectives-detail:not(.is-two) .objectives-detail-scroll, .objectives-detail.is-two .objectives-detail-pane, .objectives-zoom") ?? boundary);
        pop.style.visibility = "hidden";
        setPosition(null);
        return;
      }
      const self = [nb, ...(name ? [rect(name.getBoundingClientRect())] : [])];
      const bb = boundary.getBoundingClientRect();
      const left = Math.max(8, bb.left + 4), right = Math.min(innerWidth - 8, bb.right - 4);
      const top = 8, bottom = innerHeight - 8;
      const width = Math.min(bb.width >= 700 ? 300 : 280, right - left);
      pop.style.width = `${width}px`;
      const full = Math.min((pop.querySelector<HTMLElement>(".objectives-popup-body")?.scrollHeight ?? pop.scrollHeight) + 22, 490);
      const others = [...boundary.querySelectorAll<HTMLElement>("[data-graph-node]")].filter(n => n !== node).map(n => rect(n.getBoundingClientRect()));
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
        const paths = [...boundary.querySelectorAll<SVGPathElement>(".objectives-graph-edge")].filter(e => e.dataset.from === missionId || e.dataset.to === missionId);
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
          return { d: points.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" "), down: path.dataset.from === missionId };
        });
        setLinks(old => JSON.stringify(old) === JSON.stringify(next) ? old : next);
      }
    };
    place();
    let frame = 0;
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; place(); }); };
    const observer = new ResizeObserver(schedule);
    observer.observe(pop); observer.observe(boundary); observer.observe(node);
    for (const ancestor of ancestors) observer.observe(ancestor);
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener("resize", schedule); document.removeEventListener("scroll", schedule, true); };
  }, [missionId, layout, boundary]);
  const focused = useRef(false);
  useLayoutEffect(() => { focused.current = false; }, [missionId, focus, closing]);
  useLayoutEffect(() => {
    const pop = ref.current;
    if (!pop || !position || !focus || closing || hidden || focused.current) return;
    // 위치가 커밋되어 보인 뒤에만 초점을 준다 — 스크롤 reveal과 같은 프레임의 숨은 DOM은 focus를 받지 못한다.
    (pop.querySelector<HTMLElement>("textarea") ?? pop.querySelector<HTMLElement>("button:not(:disabled)"))?.focus({ preventScroll: true });
    focused.current = pop.contains(document.activeElement);
  }, [position, focus, closing, hidden, missionId]);
  return createPortal(<><div ref={ref} id={id} role="dialog" aria-label={label} data-graph-popup data-side={position?.side} className={`objectives-graph-popup${pinned ? " is-pinned" : ""}${closing ? " is-closing" : ""}`} style={{ left: position?.x ?? 0, top: position?.y ?? 0, width: position?.width ?? 280, maxHeight: position?.height ?? 490, visibility: !position || hidden ? "hidden" : undefined }} onPointerEnter={onKeep} onPointerMove={onMove} onPointerLeave={onLeave} onPointerDown={onPin} onFocus={onKeep} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onEscape(); } }}>
    <span className={`objectives-popup-tail is-${position?.side ?? "below"}`} style={position?.side === "left" || position?.side === "right" ? { top: position.tail } : { left: position?.tail ?? 20 }} />
    <div className="objectives-popup-body" style={{ maxHeight: position ? position.height - 22 : 468 }}>{children}</div>
  </div>{position && !hidden && !closing ? <svg className="objectives-popup-links" aria-hidden="true"><defs><clipPath id={clipId}><rect x={position.x} y={position.y} width={position.width} height={position.height} rx={8} /></clipPath></defs><g clipPath={`url(#${clipId})`}>{links.map((link, i) => <path key={i} d={link.d} className={link.down ? "is-down" : undefined} />)}</g></svg> : null}</>, boundary.closest(".objectives-zoom") ?? document.body);
}
