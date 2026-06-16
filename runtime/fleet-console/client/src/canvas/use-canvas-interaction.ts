import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";

import { screenToCanvas, type CanvasPoint, type CanvasRect, type CanvasViewport } from "./coordinates.js";

interface CanvasInteractionOptions {
  readonly viewport: CanvasViewport;
  readonly disabled?: boolean;
  readonly consumePointerDown?: boolean;
  readonly onViewportChange: (viewport: CanvasViewport) => void;
  readonly onCreate: (rect: CanvasRect, anchor: CanvasPoint) => void;
  readonly onConsumePointerDown?: () => void;
}

interface CanvasInteractionResult {
  readonly rubberBand: CanvasRect | null;
  readonly spaceActive: boolean;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onWheel: (event: ReactWheelEvent<HTMLDivElement>) => void;
}

type DragMode = "pan" | "create";

interface DragState {
  readonly pointerId: number;
  readonly mode: DragMode;
  readonly startScreen: CanvasPoint;
  readonly currentScreen: CanvasPoint;
  readonly startViewport: CanvasViewport;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
const MIN_CREATE_WIDTH = 200;
const MIN_CREATE_HEIGHT = 150;
const DEFAULT_CREATE_WIDTH = 640;
const DEFAULT_CREATE_HEIGHT = 400;
const ZOOM_STEP = 0.0018;

export function useCanvasInteraction({ viewport, disabled = false, consumePointerDown = false, onViewportChange, onCreate, onConsumePointerDown }: CanvasInteractionOptions): CanvasInteractionResult {
  const dragRef = useRef<DragState | null>(null);
  const viewportRef = useRef(viewport);
  const [rubberBand, setRubberBand] = useState<CanvasRect | null>(null);
  const [spaceActive, setSpaceActive] = useState(false);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (event.code === "Space") {
        event.preventDefault();
        setSpaceActive(true);
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") setSpaceActive(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || isBlockedTarget(event.target)) return;
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    if (consumePointerDown) {
      onConsumePointerDown?.();
      return;
    }
    const screen = eventScreenPoint(event);
    const mode: DragMode = event.button === 1 || spaceActive ? "pan" : "create";
    dragRef.current = {
      pointerId: event.pointerId,
      mode,
      startScreen: screen,
      currentScreen: screen,
      startViewport: viewportRef.current,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    if (mode === "create") setRubberBand(rectFromScreens(screen, screen, viewportRef.current));
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const currentScreen = eventScreenPoint(event);
    dragRef.current = { ...drag, currentScreen };
    if (drag.mode === "pan") {
      onViewportChange({
        ...drag.startViewport,
        x: drag.startViewport.x + currentScreen.x - drag.startScreen.x,
        y: drag.startViewport.y + currentScreen.y - drag.startScreen.y,
      });
      return;
    }
    setRubberBand(rectFromScreens(drag.startScreen, currentScreen, viewportRef.current));
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    finishPointer(event, true);
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    finishPointer(event, false);
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (disabled || isBlockedTarget(event.target)) return;
    event.preventDefault();
    const screen = eventScreenPoint(event);
    const current = viewportRef.current;
    if (event.ctrlKey || event.metaKey) {
      const zoom = clamp(current.zoom * Math.exp(-event.deltaY * ZOOM_STEP), MIN_ZOOM, MAX_ZOOM);
      const canvas = screenToCanvas(screen, current);
      onViewportChange({
        x: screen.x - canvas.x * zoom,
        y: screen.y - canvas.y * zoom,
        zoom,
      });
      return;
    }
    onViewportChange({
      ...current,
      x: current.x - event.deltaX,
      y: current.y - event.deltaY,
    });
  };

  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setRubberBand(null);
    if (!commit || drag.mode !== "create") return;
    const raw = rectFromScreens(drag.startScreen, drag.currentScreen, viewportRef.current);
    const rect = raw.width < MIN_CREATE_WIDTH || raw.height < MIN_CREATE_HEIGHT
      ? {
          x: screenToCanvas(drag.startScreen, viewportRef.current).x,
          y: screenToCanvas(drag.startScreen, viewportRef.current).y,
          width: DEFAULT_CREATE_WIDTH,
          height: DEFAULT_CREATE_HEIGHT,
        }
      : raw;
    onCreate(rect, drag.currentScreen);
  };

  return { rubberBand, spaceActive, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onWheel };
}

function rectFromScreens(start: CanvasPoint, current: CanvasPoint, viewport: CanvasViewport): CanvasRect {
  const a = screenToCanvas(start, viewport);
  const b = screenToCanvas(current, viewport);
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

function eventScreenPoint(event: ReactPointerEvent<HTMLDivElement> | ReactWheelEvent<HTMLDivElement>): CanvasPoint {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function isBlockedTarget(target: EventTarget): boolean {
  return target instanceof Element && Boolean(target.closest("[data-canvas-blocker], [data-canvas-panel]"));
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
