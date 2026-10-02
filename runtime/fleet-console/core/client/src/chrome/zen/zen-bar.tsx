import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";

import { ZenIslandControls } from "../../../../../features/workspace/client/zen/zen-island-controls.js";
import { useTriageActive } from "../../../../../features/workspace/client/canvas/triage-store.js";
import { useSideBarState } from "../../../../../features/workspace/client/sidebar/operations-side-bar-store.js";
import { useT } from "../../i18n/index.js";
import { setZenToolbarHost } from "../../integration/toolbar-slots.js";
import { useZenModeState } from "../../integration/zen-mode.js";
import { BrandMarkIcon, BrandWordmark } from "../components/command-band.js";

/** 도구모음은 같은 DOM을 들고 옮겨 온다. 섬은 아레나를 비우지 않는 창 단위 크롬이다. */
type Corner = "bottom-right" | "bottom-left" | "top-right";
const CORNERS: readonly Corner[] = ["bottom-right", "bottom-left", "top-right"];
const STORAGE_KEY = "fleet-console.zen.island-corner";
const EDGE = 12;
const HEIGHT = 40;

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
  const [dragPosition, setDragPosition] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const warRoom = useTriageActive();
  const zenState = useZenModeState();
  const sidebar = useSideBarState();
  const sidebarShown = zenState.sideBarRevealed && !sidebar.collapsed;
  const moveTo = (next: Corner) => {
    setCorner(next);
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* 배치 기억이 막혀도 이번 창에서는 이동한다. */ }
  };
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!active || !bar) return;
    const sidebar = document.querySelector<HTMLElement>(".operations-side-bar");
    const measure = () => setSize({
      width: bar.getBoundingClientRect().width,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      sidebarRight: sidebarShown && sidebar ? sidebar.offsetLeft + sidebar.offsetWidth : 0,
    });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    if (sidebar) observer.observe(sidebar);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [active, sidebarShown]);
  useEffect(() => {
    if (!active) return;
    document.documentElement.dataset.zenIslandCorner = corner;
    return () => { delete document.documentElement.dataset.zenIslandCorner; };
  }, [active, corner]);

  const positionFor = (at: Corner) => ({
    x: at === "bottom-left"
      ? Math.min(Math.max(EDGE, size.sidebarRight + (sidebarShown ? EDGE : 0)), Math.max(EDGE, size.viewportWidth - size.width - EDGE))
      : Math.max(EDGE, size.viewportWidth - size.width - EDGE),
    y: at === "top-right" ? EDGE : Math.max(EDGE, size.viewportHeight - HEIGHT - EDGE),
  });
  const position = dragPosition ?? positionFor(corner);
  const endDrag = (event: PointerEvent<HTMLSpanElement>, canceled = false) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (drag.moved && !canceled) {
      const rect = barRef.current!.getBoundingClientRect();
      const nearest = [...CORNERS].sort((a, b) => {
        const left = positionFor(a), right = positionFor(b);
        return Math.hypot(left.x - rect.left, left.y - rect.top) - Math.hypot(right.x - rect.left, right.y - rect.top);
      })[0]!;
      moveTo(nearest);
    }
    setDragPosition(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return <div ref={barRef} className={`zen-bar${warRoom ? " is-war-room" : ""}${corner === "bottom-left" ? " is-mirrored" : ""}${dragPosition ? " is-dragging" : ""}`}
    data-corner={corner} data-keep-operation-active="" hidden={!active} role="group" aria-label={t("zen.bar.aria")}
    style={{ left: position.x, top: position.y }}>
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
        dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 4) return;
        drag.moved = true;
        setDragPosition({ x: Math.max(EDGE, Math.min(size.viewportWidth - size.width - EDGE, drag.left + dx)), y: Math.max(EDGE, Math.min(size.viewportHeight - HEIGHT - EDGE, drag.top + dy)) });
      }}
      onPointerUp={endDrag} onPointerCancel={(event) => endDrag(event, true)} onLostPointerCapture={(event) => endDrag(event, true)}>
      <BrandMarkIcon className="zen-bar-brand-glyph" local={local} />
      <BrandWordmark className="zen-bar-brand-wordmark" local={local} />
    </span>
  </div>;
}
