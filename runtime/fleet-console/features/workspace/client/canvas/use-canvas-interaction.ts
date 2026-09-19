import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";

import { screenToCanvas, type CanvasPoint, type CanvasRect, type CanvasViewport } from "./coordinates.js";
import { resolveWheelZoomFloor } from "./fleet-map-layout.js";

interface CanvasInteractionOptions {
  readonly viewport: CanvasViewport;
  readonly disabled?: boolean;
  readonly consumePointerDown?: boolean;
  // pan(드래그)은 즉시 적용한다.
  readonly onViewportChange: (viewport: CanvasViewport) => void;
  // 휠 줌은 보간 경로로 보낸다(스토어 rAF tween).
  /** 목표 viewport와 그 계산의 앵커가 된 화면 점(캔버스-local). */
  readonly onZoom: (viewport: CanvasViewport, screen: CanvasPoint) => void;
  readonly onCreate: (rect: CanvasRect, anchor: CanvasPoint) => void;
  readonly onConsumePointerDown?: () => void;
  readonly onClick?: () => void;
}

interface CanvasInteractionResult {
  readonly rubberBand: CanvasRect | null;
  readonly spaceActive: boolean;
  readonly shiftActive: boolean;
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

// 휠 줌 하한은 함대 지도가 서는 층이다(resolveWheelZoomFloor) — 함대가 점으로 잦아든 뒤의
// 축소는 판을 바꾸지 못한다. fit-all(FIT_ALL_MIN_ZOOM 0.02)이 그 층보다 깊게 데려간 뷰포트에서는
// 하한이 현재 배율까지 따라 내려가, 축소 휠이 하한으로 튀어 방향이 뒤집히는 일이 없다.
const MAX_ZOOM = 2;
const MIN_CREATE_WIDTH = 200;
const MIN_CREATE_HEIGHT = 150;
// 이 픽셀(화면 좌표) 미만의 포인터 이동은 드래그가 아니라 단일 클릭으로 간주한다.
const CLICK_MOVE_THRESHOLD = 5;
const ZOOM_STEP = 0.0018;

export function useCanvasInteraction({ viewport, disabled = false, consumePointerDown = false, onViewportChange, onZoom, onCreate, onConsumePointerDown, onClick }: CanvasInteractionOptions): CanvasInteractionResult {
  const dragRef = useRef<DragState | null>(null);
  const viewportRef = useRef(viewport);
  const [rubberBand, setRubberBand] = useState<CanvasRect | null>(null);
  const [spaceActive, setSpaceActive] = useState(false);
  const [shiftActive, setShiftActive] = useState(false);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Shift는 생성 모드 커서(crosshair) 표시용이라 입력 필드 포커스 여부와 무관하게 추적한다.
      if (event.key === "Shift") setShiftActive(true);
      if (isEditableTarget(event.target)) return;
      if (event.code === "Space") {
        event.preventDefault();
        setSpaceActive(true);
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift") setShiftActive(false);
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
    // 기본 드래그는 맵 이동(pan). Shift+좌클릭 드래그만 새 Operation 생성(create).
    // 중간 버튼(button 1)과 Space 길게 누름은 보조 pan 경로로 유지한다.
    const mode: DragMode = event.shiftKey && event.button === 0 && !spaceActive ? "create" : "pan";
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
    // 기본 휠 업/다운으로 포인터 위치를 기준점 삼아 줌 인/아웃한다(Ctrl/⌘ 보조키 없이). 맵 이동은 드래그가 담당한다.
    // 줌 목표는 보간 경로(onZoom)로 보내 스토어 rAF tween이 부드럽게 수렴시킨다(기준점은 현재 viewport 기준으로 계산).
    const zoom = clamp(current.zoom * Math.exp(-event.deltaY * ZOOM_STEP), resolveWheelZoomFloor(current.zoom), MAX_ZOOM);
    const canvas = screenToCanvas(screen, current);
    onZoom({
      x: screen.x - canvas.x * zoom,
      y: screen.y - canvas.y * zoom,
      zoom,
    }, screen);
  };

  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setRubberBand(null);
    if (!commit) return;
    // 거의 움직이지 않았으면(=단일 클릭) 모드와 무관하게 캔버스 제어 의도로 본다 — 호출 측에서 터미널 포커스를 해제한다.
    const moveX = Math.abs(drag.currentScreen.x - drag.startScreen.x);
    const moveY = Math.abs(drag.currentScreen.y - drag.startScreen.y);
    if (moveX < CLICK_MOVE_THRESHOLD && moveY < CLICK_MOVE_THRESHOLD) {
      onClick?.();
      return;
    }
    // pan 드래그는 onPointerMove에서 이미 viewport를 옮겼다. 생성은 Shift+드래그(create)일 때만.
    if (drag.mode !== "create") return;
    // 실제 드래그 → 드래그한 사각형으로 생성하되, 너무 작으면 최소 크기로 클램프해 사용 가능하게 한다.
    const raw = rectFromScreens(drag.startScreen, drag.currentScreen, viewportRef.current);
    const rect: CanvasRect = {
      x: raw.x,
      y: raw.y,
      width: Math.max(raw.width, MIN_CREATE_WIDTH),
      height: Math.max(raw.height, MIN_CREATE_HEIGHT),
    };
    onCreate(rect, drag.currentScreen);
  };

  return { rubberBand, spaceActive, shiftActive, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onWheel };
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
  return target instanceof Element && Boolean(target.closest("[data-canvas-blocker], [data-canvas-operation]"));
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
