import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";

import { ZenIslandControls } from "../../../../../features/workspace/client/zen/zen-island-controls.js";
import { useTriageActive } from "../../../../../features/workspace/client/canvas/triage-store.js";
import { useSideBarState } from "../../../../../features/workspace/client/sidebar/operations-side-bar-store.js";
import { useT } from "../../i18n/index.js";
import { setZenToolbarHost } from "../../integration/toolbar-slots.js";
import { useZenModeState } from "../../integration/zen-mode.js";
import { BrandMarkIcon, BrandWordmark } from "../components/command-band.js";
import { useRailDragDeltaPx, useRailSettledPx } from "../rail/rail-store.js";

/** 도구모음은 같은 DOM을 들고 옮겨 온다. 섬은 아레나를 비우지 않는 창 단위 크롬이다. */
type Corner = "bottom-right" | "bottom-left" | "top-right";
interface Point { readonly x: number; readonly y: number }
const CORNERS: readonly Corner[] = ["bottom-right", "bottom-left", "top-right"];
const STORAGE_KEY = "fleet-console.zen.island-corner";
const EDGE = 12;
const HEIGHT = 40;
/** 레일 카드와 아레나 사이 틈 — Operations의 CHROME_FLOAT_GUTTER와 같은 값. 섬은 이 틈 안쪽, 맵 아레나 안에만 선다. */
const RAIL_GUTTER = 24;

function readCorner(): Corner {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return CORNERS.find((corner) => corner === value) ?? "bottom-right";
  } catch { return "bottom-right"; }
}

export function ZenBar({ active, local = false }: { readonly active: boolean; readonly local?: boolean }) {
  const t = useT();
  const barRef = useRef<HTMLDivElement>(null);
  const [corner, setCorner] = useState<Corner>(readCorner);
  const [size, setSize] = useState({ width: 0, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, sidebarRight: 0 });
  const [dragPosition, setDragPosition] = useState<Point | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number; moved: boolean; last: Point } | null>(null);
  const flightFromRef = useRef<Point | null>(null);
  const flightRef = useRef<Animation | null>(null);
  const warRoom = useTriageActive();
  const zenState = useZenModeState();
  const sidebar = useSideBarState();
  const sidebarShown = zenState.sideBarRevealed && !sidebar.collapsed;
  // 오른쪽 레일이 점유한 폭만큼 섬의 오른쪽 경계를 아레나 안으로 들인다. 레일을 끄는 동안에도 따라간다.
  const railPx = useRailSettledPx() + useRailDragDeltaPx(active);
  const arenaRight = railPx > 0 ? railPx + RAIL_GUTTER : 0;
  const moveTo = (next: Corner, from?: Point) => {
    if (next === corner && !from) return;
    const rect = barRef.current?.getBoundingClientRect();
    flightFromRef.current = from ?? (rect ? { x: rect.left, y: rect.top } : null);
    setCorner(next);
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* 배치 기억이 막혀도 이번 창에서는 이동한다. */ }
  };
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!active || !bar) return;
    const sidebar = document.querySelector<HTMLElement>(".operations-side-bar");
    // 자연 폭은 위치와 독립이다. 끌기 scale·착지 transform은 폭 측정에 섞지 않는다.
    const measure = () => {
      const next = {
        width: bar.offsetWidth,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        sidebarRight: sidebarShown && sidebar ? sidebar.offsetLeft + sidebar.offsetWidth : 0,
      };
      setSize((current) => Object.keys(next).every((key) => current[key as keyof typeof next] === next[key as keyof typeof next]) ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    if (sidebar) observer.observe(sidebar);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [active, sidebarShown]);
  // 모서리는 right/bottom 앵커로 곧바로 선다. 서로 다른 앵커 사이의 비행만 FLIP으로 잇는다.
  useLayoutEffect(() => {
    const from = flightFromRef.current;
    const bar = barRef.current;
    if (!from || !active || !bar || dragPosition !== null) return;
    flightFromRef.current = null;
    flightRef.current?.cancel();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const to = bar.getBoundingClientRect();
    flightRef.current = bar.animate([
      { transform: `translate(${from.x - to.left}px, ${from.y - to.top}px)` },
      { transform: "none" },
    ], { duration: 340, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
  }, [active, corner, dragPosition]);
  useEffect(() => () => flightRef.current?.cancel(), []);
  useEffect(() => {
    if (!active) return;
    document.documentElement.dataset.zenIslandCorner = corner;
    return () => { delete document.documentElement.dataset.zenIslandCorner; };
  }, [active, corner]);

  const positionFor = (at: Corner): Point => ({
    x: at === "bottom-left"
      ? Math.min(Math.max(EDGE, size.sidebarRight + (sidebarShown ? EDGE : 0)), Math.max(EDGE, size.viewportWidth - arenaRight - size.width - EDGE))
      : Math.max(EDGE, size.viewportWidth - arenaRight - size.width - EDGE),
    y: at === "top-right" ? EDGE : Math.max(EDGE, size.viewportHeight - HEIGHT - EDGE),
  });
  const anchorStyle = (at: Corner): CSSProperties => ({
    ...(at === "bottom-left" ? { left: positionFor(at).x } : { right: arenaRight + EDGE }),
    ...(at === "top-right" ? { top: EDGE } : { bottom: EDGE }),
  });
  const clampPosition = (x: number, y: number): Point => ({
    x: Math.max(EDGE, Math.min(size.viewportWidth - arenaRight - size.width - EDGE, x)),
    y: Math.max(EDGE, Math.min(size.viewportHeight - HEIGHT - EDGE, y)),
  });
  const nearestCorner = (point: Point): Corner => [...CORNERS].sort((a, b) => {
    const left = positionFor(a), right = positionFor(b);
    return Math.hypot(left.x - point.x, left.y - point.y) - Math.hypot(right.x - point.x, right.y - point.y);
  })[0]!;
  const endDrag = (event: PointerEvent<HTMLSpanElement>, canceled = false) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (drag.moved) {
      // pointerup이 마지막 이동의 정본이다. 렌더가 밀려도 옛 DOM rect로 모서리를 고르지 않는다.
      const point = canceled ? drag.last : clampPosition(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
      moveTo(canceled ? corner : nearestCorner(point), point);
    }
    setDragPosition(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const previewCorner = dragPosition ? nearestCorner(dragPosition) : null;

  return <>
    {active && previewCorner ? <div className="zen-island-drop-target" data-corner={previewCorner} aria-hidden="true" style={{ ...anchorStyle(previewCorner), width: size.width, height: HEIGHT }} /> : null}
    <div ref={barRef} className={`zen-bar${warRoom ? " is-war-room" : ""}${corner === "bottom-left" ? " is-mirrored" : ""}${dragPosition ? " is-dragging" : ""}`}
      data-corner={corner} data-keep-operation-active="" hidden={!active} role="group" aria-label={t("zen.bar.aria")}
      style={dragPosition ? { left: dragPosition.x, top: dragPosition.y } : anchorStyle(corner)}>
      {active ? <ZenIslandControls /> : null}
      <span className="zen-bar-toolbar" ref={setZenToolbarHost} />
      <span className="zen-bar-brand" data-zen-island-handle="" role="button" tabIndex={0} aria-label={t("zen.island.move")} title={t("zen.island.move")}
        onDoubleClick={() => moveTo("bottom-right")}
        onKeyDown={(event) => {
          if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
          const next = event.key === "ArrowLeft" ? "bottom-left" : event.key === "ArrowUp" ? "top-right" : event.key === "ArrowRight" || event.key === "ArrowDown" ? "bottom-right" : null;
          if (next) { event.preventDefault(); event.stopPropagation(); moveTo(next); }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const rect = barRef.current!.getBoundingClientRect();
          flightRef.current?.cancel();
          flightFromRef.current = null;
          dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false, last: { x: rect.left, y: rect.top } };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
          if (!drag.moved && Math.hypot(dx, dy) < 4) return;
          drag.moved = true;
          drag.last = clampPosition(drag.left + dx, drag.top + dy);
          setDragPosition(drag.last);
        }}
        onPointerUp={endDrag} onPointerCancel={(event) => endDrag(event, true)} onLostPointerCapture={(event) => endDrag(event, true)}>
        <BrandMarkIcon className="zen-bar-brand-glyph" local={local} />
        <BrandWordmark className="zen-bar-brand-wordmark" local={local} />
      </span>
    </div>
  </>;
}
