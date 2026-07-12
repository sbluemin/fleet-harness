import { useRef, type PointerEvent as ReactPointerEvent } from "react";

import type { CanvasViewport, OperationGeometry } from "./canvas-store.js";
import type { CanvasPoint } from "./coordinates.js";

interface PluginOperationEntry {
  readonly theaterId: string;
  readonly geometry: OperationGeometry;
}

interface CanvasMinimapProps {
  readonly operations: Record<string, OperationGeometry>;
  readonly pluginOperations: Record<string, PluginOperationEntry>;
  readonly viewport: CanvasViewport;
  readonly canvasSize: { readonly width: number; readonly height: number };
  // 미니맵의 한 지점을 캔버스 중앙으로 가져오도록 뷰포트를 옮긴다(world 좌표).
  readonly onJump: (center: CanvasPoint) => void;
}

interface MiniRect {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const MINIMAP_WIDTH = 256;
const MINIMAP_HEIGHT = 176;
const MINIMAP_PADDING = 12;
// Operation/뷰포트 묶음 주변에 두는 world 여유 — 가장자리에 붙지 않게 한다.
const WORLD_MARGIN = 220;

export function CanvasMinimap({ operations, pluginOperations, viewport, canvasSize, onJump }: CanvasMinimapProps) {
  const innerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  if (canvasSize.width <= 0 || canvasSize.height <= 0 || viewport.zoom <= 0) return null;

  const rects: MiniRect[] = [
    ...Object.entries(operations).map(([id, g]) => ({ id, x: g.x, y: g.y, width: g.width, height: g.height })),
    ...Object.entries(pluginOperations).map(([id, e]) => ({ id, x: e.geometry.x, y: e.geometry.y, width: e.geometry.width, height: e.geometry.height })),
  ];
  // 표시할 Operation이 없으면 위치 인지에 의미가 없으므로 미니맵을 숨긴다.
  if (rects.length === 0) return null;

  const innerW = MINIMAP_WIDTH - MINIMAP_PADDING * 2;
  const innerH = MINIMAP_HEIGHT - MINIMAP_PADDING * 2;

  // 현재 화면에 보이는 world 영역(뷰포트 인디케이터의 근거).
  const view = {
    x: -viewport.x / viewport.zoom,
    y: -viewport.y / viewport.zoom,
    width: canvasSize.width / viewport.zoom,
    height: canvasSize.height / viewport.zoom,
  };

  let minX = Math.min(view.x, ...rects.map((r) => r.x));
  let minY = Math.min(view.y, ...rects.map((r) => r.y));
  let maxX = Math.max(view.x + view.width, ...rects.map((r) => r.x + r.width));
  let maxY = Math.max(view.y + view.height, ...rects.map((r) => r.y + r.height));
  minX -= WORLD_MARGIN;
  minY -= WORLD_MARGIN;
  maxX += WORLD_MARGIN;
  maxY += WORLD_MARGIN;

  const worldW = maxX - minX;
  const worldH = maxY - minY;
  const scale = Math.min(innerW / worldW, innerH / worldH);
  const offsetX = (innerW - worldW * scale) / 2;
  const offsetY = (innerH - worldH * scale) / 2;

  const miniLeft = (wx: number) => offsetX + (wx - minX) * scale;
  const miniTop = (wy: number) => offsetY + (wy - minY) * scale;

  const jumpToEvent = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = innerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = event.clientX - rect.left;
    const cy = event.clientY - rect.top;
    onJump({ x: minX + (cx - offsetX) / scale, y: minY + (cy - offsetY) / scale });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    jumpToEvent(event);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    event.stopPropagation();
    jumpToEvent(event);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 포인터 캡처 해제 실패는 무시한다(이미 해제된 경우).
    }
  };

  return (
    <div className="canvas-minimap" data-canvas-blocker style={{ width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT }}>
      <span className="canvas-minimap-label" aria-hidden="true">Map</span>
      <div
        ref={innerRef}
        className="canvas-minimap-inner"
        style={{ inset: MINIMAP_PADDING }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        role="presentation"
        aria-label="Canvas minimap — drag to navigate"
      >
        {rects.map((r) => (
          <div
            key={r.id}
            className="canvas-minimap-operation"
            style={{ left: miniLeft(r.x), top: miniTop(r.y), width: Math.max(2, r.width * scale), height: Math.max(2, r.height * scale) }}
          />
        ))}
        <div
          className="canvas-minimap-view"
          style={{ left: miniLeft(view.x), top: miniTop(view.y), width: view.width * scale, height: view.height * scale }}
        />
      </div>
    </div>
  );
}
