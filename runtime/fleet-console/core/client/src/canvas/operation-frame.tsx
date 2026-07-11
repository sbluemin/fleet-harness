import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent as ReactWheelEvent } from "react";

import type { OperationNode, OperationGeometry } from "@fleet-console/sdk/operations";
import type { OperationActivity } from "@fleet-console/sdk/plugin";

import { operationActivityVisual } from "../operation-activity.js";
import { AccentPopover } from "./accent-popover.js";
import { resolveAccentColor } from "./operation-accent.js";

interface OperationFrameProps {
  readonly operation: OperationNode;
  readonly active: boolean;
  readonly geometry: OperationGeometry;
  readonly zoom: number;
  readonly status?: OperationActivity;
  readonly minimized?: boolean;
  readonly maximized?: boolean;
  readonly interactionDisabled?: boolean;
  readonly accentKey?: string | null;
  readonly children: ReactNode;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onMinimize: () => void;
  readonly onMaximize?: () => void;
  readonly onSetAccent?: (accentKey: string | null) => void;
  readonly onGeometryChange: (geometry: OperationGeometry) => void;
  readonly onGeometryCommit: (geometry: OperationGeometry) => void;
}

interface DragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly geometry: OperationGeometry;
  latest: OperationGeometry;
}

interface ResizeState extends DragState {
  readonly direction: ResizeDirection;
}

type ResizeDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

const RESIZE_DIRECTIONS: readonly ResizeDirection[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
const MIN_OPERATION_WIDTH = 320;
const MIN_OPERATION_HEIGHT = 200;

export function OperationFrame({ operation, active, geometry, zoom, status, minimized = false, maximized = false, interactionDisabled = false, accentKey = null, children, onActivate, onClose, onMinimize, onMaximize, onSetAccent, onGeometryChange, onGeometryCommit }: OperationFrameProps) {
  const operationRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const [accentAnchor, setAccentAnchor] = useState<DOMRect | null>(null);
  const displayTitle = operation.title;
  // accent를 패널 외곽 box-shadow 링으로 칠한다(--op-accent). status(테두리·진행광)·focus(brass)와 채널이 달라 공존한다.
  const accentColor = accentKey ? resolveAccentColor(accentKey) : null;
  const className = [
    "canvas-operation",
    active ? "is-active" : "",
    minimized ? "is-minimized" : "",
    maximized ? "is-maximized" : "",
    frameStatusClass(status),
  ].filter(Boolean).join(" ");

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (maximized || interactionDisabled) return;
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onActivate();
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, geometry, latest: geometry };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updateDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (maximized || interactionDisabled) return;
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const next = {
      ...drag.geometry,
      x: drag.geometry.x + (event.clientX - drag.startX) / zoom,
      y: drag.geometry.y + (event.clientY - drag.startY) / zoom,
    };
    drag.latest = next;
    onGeometryChange(next);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (maximized || interactionDisabled) {
      dragRef.current = null;
      return;
    }
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    onGeometryCommit(drag.latest);
  };

  const beginResize = (direction: ResizeDirection, event: ReactPointerEvent<HTMLDivElement>) => {
    if (maximized || interactionDisabled) return;
    event.preventDefault();
    event.stopPropagation();
    onActivate();
    resizeRef.current = { direction, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, geometry, latest: geometry };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updateResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (maximized || interactionDisabled) return;
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const next = resizeGeometry(resize.geometry, resize.direction, (event.clientX - resize.startX) / zoom, (event.clientY - resize.startY) / zoom);
    resize.latest = next;
    onGeometryChange(next);
  };

  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (maximized || interactionDisabled) {
      resizeRef.current = null;
      return;
    }
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    onGeometryCommit(resize.latest);
  };

  const stopButtonPointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  const stopOperationPointer = (event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
    onActivate();
  };

  const stopOperationWheel = (event: ReactWheelEvent<HTMLElement>) => {
    event.stopPropagation();
  };

  const minimize = () => {
    const activeElement = typeof document !== "undefined" ? document.activeElement : null;
    if (activeElement instanceof HTMLElement && operationRef.current?.contains(activeElement)) activeElement.blur();
    onMinimize();
  };

  const openAccentPopover = (anchor: DOMRect) => {
    onActivate();
    setAccentAnchor(anchor);
  };

  // 패널 좌표·크기를 정수 픽셀로 스냅해 패널·내부 xterm 캔버스 원점을 정수 픽셀에 정렬한다(서브픽셀 번짐 제거).
  const frameStyle = {
    left: Math.round(geometry.x),
    top: Math.round(geometry.y),
    width: Math.round(geometry.width),
    height: Math.round(geometry.height),
    zIndex: geometry.zIndex,
    ...(accentColor ? { "--op-accent": accentColor } : {}),
  } as CSSProperties;

  return (
    <article
      ref={operationRef}
      className={className}
      style={frameStyle}
      onPointerDown={onActivate}
      data-canvas-operation
      aria-label={`Operation ${displayTitle}`}
      inert={minimized ? true : undefined}
    >
      {!maximized && !interactionDisabled ? (
        <div
          className="canvas-operation-drag-edge"
          onPointerDown={beginDrag}
          onPointerMove={updateDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          data-canvas-blocker
          aria-hidden="true"
        />
      ) : null}
      <div
        className="canvas-operation-titlebar"
        onPointerDown={beginDrag}
        onPointerMove={updateDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        data-canvas-blocker
      >
        {onSetAccent ? (
          <button
            type="button"
            className="canvas-operation-beacon-button"
            onPointerDown={stopButtonPointer}
            onClick={(event) => openAccentPopover(event.currentTarget.getBoundingClientRect())}
            aria-label={`Set accent for operation ${displayTitle}`}
            aria-haspopup="menu"
            title="Set accent"
          >
            <span className={beaconStatusClass(status)} aria-hidden="true" />
          </button>
        ) : (
          <span className={beaconStatusClass(status)} onPointerDown={(event) => { event.stopPropagation(); onActivate(); }} aria-hidden="true" />
        )}
        <button type="button" className="canvas-operation-icon-button" onPointerDown={stopButtonPointer} onClick={minimize} aria-label={`Minimize operation ${displayTitle}`} title="Minimize operation">
          <MinimizeIcon />
        </button>
        {onMaximize ? (
          <button type="button" className={`canvas-operation-icon-button ${maximized ? "is-active" : ""}`} onPointerDown={stopButtonPointer} onClick={onMaximize} aria-label={maximized ? `Restore operation ${displayTitle}` : `Maximize operation ${displayTitle}`} aria-pressed={maximized} title={maximized ? "Restore operation" : "Maximize operation"}>
            {maximized ? <RestorePanelIcon /> : <MaximizePanelIcon />}
          </button>
        ) : null}
        <button type="button" className="canvas-operation-icon-button" onPointerDown={stopButtonPointer} onClick={onClose} aria-label={`Close operation ${displayTitle}`} title="Close operation">
          <CloseIcon />
        </button>
      </div>
      <div className="canvas-operation-terminal" onPointerDown={stopOperationPointer} onWheel={stopOperationWheel} data-canvas-blocker>
        {children}
      </div>
      {/* 최대화 상태에서는 리사이즈가 차단되므로 핸들 자체를 렌더하지 않는다 —
          외곽 hover 시 resize 커서가 뜨거나 포인터를 가로채는 일이 없도록 한다. */}
      {!maximized && !interactionDisabled && RESIZE_DIRECTIONS.map((direction) => (
        <div
          key={direction}
          className={`canvas-operation-resize canvas-operation-resize--${direction}`}
          onPointerDown={(event) => beginResize(direction, event)}
          onPointerMove={updateResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          data-canvas-blocker
          aria-hidden="true"
        />
      ))}
      {accentAnchor && onSetAccent ? (
        <AccentPopover
          anchor={accentAnchor}
          accentKey={accentKey}
          onSelect={onSetAccent}
          onClose={() => setAccentAnchor(null)}
        />
      ) : null}
    </article>
  );
}

function resizeGeometry(geometry: OperationGeometry, direction: ResizeDirection, dx: number, dy: number): OperationGeometry {
  let { x, y, width, height } = geometry;
  if (direction.includes("e")) width += dx;
  if (direction.includes("s")) height += dy;
  if (direction.includes("w")) {
    x += dx;
    width -= dx;
  }
  if (direction.includes("n")) {
    y += dy;
    height -= dy;
  }
  if (width < MIN_OPERATION_WIDTH) {
    if (direction.includes("w")) x -= MIN_OPERATION_WIDTH - width;
    width = MIN_OPERATION_WIDTH;
  }
  if (height < MIN_OPERATION_HEIGHT) {
    if (direction.includes("n")) y -= MIN_OPERATION_HEIGHT - height;
    height = MIN_OPERATION_HEIGHT;
  }
  return { ...geometry, x, y, width, height };
}

function frameStatusClass(status: OperationActivity | undefined): string {
  const visual = operationActivityVisual(status);
  if (visual === "running") return "is-running is-running--turn";
  if (visual === "awaiting") return "is-running is-running--awaiting";
  return "";
}

function beaconStatusClass(status: OperationActivity | undefined): string {
  const visual = operationActivityVisual(status);
  if (visual === "running") return "tenant-beacon is-turn-running";
  if (visual === "awaiting") return "tenant-beacon is-awaiting";
  if (visual === "dormant") return "tenant-beacon is-dormant";
  return "tenant-beacon is-idle";
}

function MinimizeIcon() {
  // 타이틀바 하단 수평선 — Operation이 아래 dock으로 가라앉는 최소화 마크.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 11.5h9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function MaximizePanelIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 6V3.5H6M10 3.5h2.5V6M12.5 10v2.5H10M6 12.5H3.5V10" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RestorePanelIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6.2 3.5v2.7H3.5M9.8 3.5v2.7h2.7M12.5 9.8H9.8v2.7M3.5 9.8h2.7v2.7" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.6 4.6 11.4 11.4M11.4 4.6 4.6 11.4" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}
