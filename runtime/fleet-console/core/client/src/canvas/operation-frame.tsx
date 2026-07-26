import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent as ReactWheelEvent } from "react";

import type { OperationNode, OperationGeometry } from "@fleet-console/sdk/operations";
import type { OperationActivity } from "@fleet-console/sdk/plugin";

import { useT } from "../i18n/index.js";
import { operationActivityVisual } from "../operation-activity.js";
import { useInlineRename } from "../use-inline-rename.js";
import { AccentPopover } from "./accent-popover.js";
import type { GlanceHudModel } from "./glance-hud.js";
import { resolveAccentColor } from "./operation-accent.js";

interface OperationFrameProps {
  readonly operation: OperationNode;
  readonly active: boolean;
  readonly unseen: boolean;
  readonly geometry: OperationGeometry;
  readonly zoom: number;
  readonly status?: OperationActivity;
  readonly minimized?: boolean;
  readonly maximized?: boolean;
  readonly renderHidden?: boolean;
  readonly focusLayerTarget?: boolean;
  readonly topEdge?: boolean;
  readonly interactionDisabled?: boolean;
  readonly triageStage?: boolean;
  readonly triagePicked?: boolean;
  readonly glanceHud: GlanceHudModel;
  readonly formationSlotIndex?: number;
  readonly accentKey?: string | null;
  readonly children: ReactNode;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onMinimize: () => void;
  readonly onMaximize?: () => void;
  readonly onRename: (title: string) => void;
  readonly onSetAccent?: (accentKey: string | null) => void;
  readonly onGeometryChange: (geometry: OperationGeometry) => void;
  readonly onGeometryCommit: (geometry: OperationGeometry) => void;
  readonly onRenderHiddenFocus?: () => void;
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
const CLOSE_ARM_DURATION_MS = 1500;

export function OperationFrame({ operation, active, unseen, geometry, zoom, status, minimized = false, maximized = false, renderHidden = false, focusLayerTarget = false, topEdge = false, interactionDisabled = false, triageStage = false, triagePicked = false, glanceHud, formationSlotIndex, accentKey = null, children, onActivate, onClose, onMinimize, onMaximize, onRename, onSetAccent, onGeometryChange, onGeometryCommit, onRenderHiddenFocus }: OperationFrameProps) {
  const t = useT();
  const operationRef = useRef<HTMLElement | null>(null);
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const identityTriggerRef = useRef<HTMLButtonElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const closeArmTimeoutRef = useRef<number | null>(null);
  const lastVisibleGeometryRef = useRef(geometry);
  const restoreIdentityFocusRef = useRef(false);
  const [accentAnchor, setAccentAnchor] = useState<DOMRect | null>(null);
  const [isCloseArmed, setIsCloseArmed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const displayTitle = operation.title;
  const rename = useInlineRename({
    currentTitle: operation.title,
    onBegin: () => {
      disarmClose();
    },
    onCommit: (title) => {
      onRename(title);
      restoreIdentityFocusRef.current = true;
    },
  });
  // 사용자 accent(정체성)는 좌측 스파인과 명판 마크만 소유한다.
  // 패널 보더/글로우/비콘은 상태 채널(brass 포커스·aurora 대기·coral 위험) 전용이다.
  const accentColor = accentKey ? resolveAccentColor(accentKey) : null;
  const className = [
    "canvas-operation",
    unseen ? "is-unseen" : "",
    active ? "is-active" : "",
    minimized ? "is-minimized" : "",
    maximized ? "is-maximized" : "",
    triageStage ? "is-triage-stage" : "",
    topEdge ? "is-top-edge" : "",
    dragging ? "is-dragging" : "",
    frameStatusClass(status),
  ].filter(Boolean).join(" ");

  useEffect(() => () => {
    if (closeArmTimeoutRef.current !== null) window.clearTimeout(closeArmTimeoutRef.current);
  }, []);

  useEffect(() => {
    if (rename.renaming || !restoreIdentityFocusRef.current) return;
    restoreIdentityFocusRef.current = false;
    const frame = window.requestAnimationFrame(() => identityTriggerRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [rename.renaming]);

  // Operation 본체는 body pool에서 createPortal로 렌더된 뒤 DOM만 이 슬롯으로 이식된다. React 합성
  // 이벤트는 DOM 트리가 아니라 React 트리를 따라 전파하므로 아래 onPointerDown(stopOperationPointer)은
  // 본체 클릭에서는 영원히 호출되지 않는다 — 본체가 화면 대부분인 Formation에서는 선택이 통째로 죽는다.
  // 네이티브 리스너는 DOM 버블링을 타므로 이식된 본체 클릭까지 닿는다. 전파를 끊으면 React root의 위임
  // 리스너까지 막히므로 여기서는 활성화만 하고, 직접 자식 경로를 소유한 React 핸들러는 그대로 둔다.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const activate = () => {
      onActivate();
    };
    terminal.addEventListener("pointerdown", activate);
    return () => terminal.removeEventListener("pointerdown", activate);
  }, [onActivate]);

  // focus layer가 현재 포커스를 담은 peer를 숨길 때는 body로 흘려보내지 않고 새 전면 frame(없으면 Canvas)으로 옮긴다.
  useLayoutEffect(() => {
    if (!renderHidden || typeof document === "undefined") return;
    // AccentPopover는 document.body에 포털되지만 frame이 소유한다. 열린 peer는 포커스 위치와 무관하게
    // 먼저 닫고, 메뉴 내부에 있던 포커스도 전면 frame/Canvas로 명시적으로 넘긴다.
    const hadAccentPopover = accentAnchor !== null;
    if (hadAccentPopover) setAccentAnchor(null);
    if (hadAccentPopover || operationRef.current?.contains(document.activeElement)) onRenderHiddenFocus?.();
  }, [accentAnchor, renderHidden, onRenderHiddenFocus]);

  const clearCloseArmTimer = () => {
    if (closeArmTimeoutRef.current === null) return;
    window.clearTimeout(closeArmTimeoutRef.current);
    closeArmTimeoutRef.current = null;
  };

  const disarmClose = () => {
    clearCloseArmTimer();
    setIsCloseArmed(false);
  };

  const armClose = () => {
    clearCloseArmTimer();
    setIsCloseArmed(true);
    closeArmTimeoutRef.current = window.setTimeout(() => {
      closeArmTimeoutRef.current = null;
      setIsCloseArmed(false);
    }, CLOSE_ARM_DURATION_MS);
  };

  // 드래그/리사이즈 도중 캡처 대상(드래그 에지·리사이즈 핸들)이 언마운트되는 상태 전환에서는
  // pointerup/pointercancel이 도달하지 않아 is-dragging이 잔존하고 공통 모션 transition이 영구 차단된다.
  useEffect(() => {
    if (!maximized && !interactionDisabled && !minimized) return;
    dragRef.current = null;
    resizeRef.current = null;
    setDragging(false);
  }, [maximized, interactionDisabled, minimized]);

  const abortPointerManipulation = () => {
    if (!dragRef.current && !resizeRef.current) return;
    dragRef.current = null;
    resizeRef.current = null;
    setDragging(false);
  };

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    disarmClose();
    if (maximized || interactionDisabled) return;
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onActivate();
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, geometry, latest: geometry };
    setDragging(true);
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
      setDragging(false);
      return;
    }
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = null;
    setDragging(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
    onGeometryCommit(drag.latest);
  };

  const beginResize = (direction: ResizeDirection, event: ReactPointerEvent<HTMLDivElement>) => {
    if (maximized || interactionDisabled) return;
    event.preventDefault();
    event.stopPropagation();
    onActivate();
    resizeRef.current = { direction, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, geometry, latest: geometry };
    setDragging(true);
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
      setDragging(false);
      return;
    }
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = null;
    setDragging(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
    onGeometryCommit(resize.latest);
  };

  const stopButtonPointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  const stopIdentityPointer = (event: ReactPointerEvent<HTMLButtonElement | HTMLInputElement>) => {
    event.stopPropagation();
    disarmClose();
  };

  const stopOperationPointer = (event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
    onActivate();
  };

  const stopOperationWheel = (event: ReactWheelEvent<HTMLElement>) => {
    event.stopPropagation();
  };

  const minimize = () => {
    disarmClose();
    const activeElement = typeof document !== "undefined" ? document.activeElement : null;
    if (activeElement instanceof HTMLElement && operationRef.current?.contains(activeElement)) activeElement.blur();
    onMinimize();
  };

  const maximize = () => {
    disarmClose();
    onMaximize?.();
  };

  const openAccentPopover = (anchor: DOMRect) => {
    disarmClose();
    onActivate();
    setAccentAnchor(anchor);
  };

  const activateBeacon = (event: ReactPointerEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    disarmClose();
    onActivate();
  };

  const close = () => {
    if (!isCloseArmed) {
      armClose();
      return;
    }
    disarmClose();
    onClose();
  };

  const beginRename = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    rename.begin();
  };

  const beginRenameFromKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Enter" && event.key !== "F2") return;
    event.preventDefault();
    event.stopPropagation();
    rename.begin();
  };

  const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") restoreIdentityFocusRef.current = true;
    rename.handleKeyDown(event);
  };

  // 최소화 커밋과 동시에 formation slot·maximize·companion 레이아웃이 해제되면 라이브 geometry가
  // 저장된 map 좌표로 회귀해, 페이드로 가시가 유지되는 동안 패널이 엉뚱한 위치에서 사라진다 —
  // 마지막 가시 geometry를 동결해 사라진 자리에서 페이드하고, 복원은 그 자리에서 목표 슬롯으로 미끄러진다.
  if (!minimized) lastVisibleGeometryRef.current = geometry;
  const effectiveGeometry = minimized ? lastVisibleGeometryRef.current : geometry;

  // 패널 좌표·크기를 정수 픽셀로 스냅해 패널·내부 xterm 캔버스 원점을 정수 픽셀에 정렬한다(서브픽셀 번짐 제거).
  const frameStyle = {
    left: Math.round(effectiveGeometry.x),
    top: Math.round(effectiveGeometry.y),
    width: Math.round(effectiveGeometry.width),
    height: Math.round(effectiveGeometry.height),
    zIndex: effectiveGeometry.zIndex,
    // Focus Layer peer는 xterm ResizeObserver가 기존 컨테이너 크기를 계속 보게 레이아웃을 보존한다.
    ...(renderHidden ? { visibility: "hidden", pointerEvents: "none" } : {}),
    ...(accentColor ? { "--user-accent": accentColor } : {}),
  } as CSSProperties;

  return (
    <article
      ref={operationRef}
      className={className}
      style={frameStyle}
      onPointerDown={onActivate}
      data-canvas-operation
      data-operation-id={operation.id}
      data-focus-layer-target={focusLayerTarget ? "true" : undefined}
      aria-label={t("canvas.frame.operationAria", { title: displayTitle })}
      aria-hidden={renderHidden || undefined}
      tabIndex={focusLayerTarget ? -1 : undefined}
      inert={minimized || renderHidden ? true : undefined}
    >
      {accentColor ? <span className="canvas-operation-spine" aria-hidden="true" /> : null}
      {!maximized && !interactionDisabled ? (
        <div
          className="canvas-operation-drag-edge"
          onPointerDown={beginDrag}
          onPointerMove={updateDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={abortPointerManipulation}
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
        onLostPointerCapture={abortPointerManipulation}
        data-canvas-blocker
      >
        {accentColor ? <span className="canvas-operation-id-mark" aria-hidden="true" /> : null}
        {rename.renaming ? (
          <input
            ref={rename.inputRef}
            className="canvas-operation-identity-input"
            value={rename.draftTitle}
            aria-label={t("canvas.frame.renameAria", { title: displayTitle })}
            onChange={(event) => rename.setDraftTitle(event.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={rename.handleBlur}
            onPointerDown={stopIdentityPointer}
          />
        ) : (
          <button
            ref={identityTriggerRef}
            type="button"
            className="canvas-operation-identity-name"
            onPointerDown={stopIdentityPointer}
            onDoubleClick={beginRename}
            onKeyDown={beginRenameFromKeyboard}
            aria-label={t("canvas.frame.renameAria", { title: displayTitle })}
            title={t("canvas.frame.renameTitle", { title: displayTitle })}
          >
            {displayTitle}
          </button>
        )}
        {triagePicked ? <span className="canvas-operation-triage-picked">{t("canvas.triage.picked")}</span> : null}
        {formationSlotIndex !== undefined ? (
          <span className="canvas-operation-formation-slot" aria-label={t("canvas.formation.slotAria", { index: formationSlotIndex })}>
            {String(formationSlotIndex).padStart(2, "0")}
          </span>
        ) : null}
        {onSetAccent ? (
          <button
            type="button"
            className="canvas-operation-beacon-button"
            onPointerDown={stopButtonPointer}
            onClick={(event) => openAccentPopover(event.currentTarget.getBoundingClientRect())}
            aria-label={t("canvas.frame.setAccentAria", { title: displayTitle })}
            aria-haspopup="menu"
            title={t("canvas.frame.setAccentTitle")}
          >
            <span className={beaconStatusClass(status)} aria-hidden="true" />
          </button>
        ) : (
          <span className={beaconStatusClass(status)} onPointerDown={activateBeacon} aria-hidden="true" />
        )}
        <div className="canvas-operation-window-controls">
          <span className="canvas-operation-controls-divider" aria-hidden="true" />
          {!triageStage ? <button type="button" className="canvas-operation-icon-button" onPointerDown={stopButtonPointer} onClick={minimize} aria-label={t("canvas.frame.minimizeAria", { title: displayTitle })} title={t("canvas.frame.minimizeTitle")}>
            <MinimizeIcon />
          </button> : null}
          {!triageStage && onMaximize ? (
            <button type="button" className={`canvas-operation-icon-button ${maximized ? "is-active" : ""}`} onPointerDown={stopButtonPointer} onClick={maximize} aria-label={maximized ? t("canvas.frame.restoreAria", { title: displayTitle }) : t("canvas.frame.maximizeAria", { title: displayTitle })} aria-pressed={maximized} title={maximized ? t("canvas.frame.restoreTitle") : t("canvas.frame.maximizeTitle")}>
              {maximized ? <RestorePanelIcon /> : <MaximizePanelIcon />}
            </button>
          ) : null}
          <button type="button" className={`canvas-operation-icon-button ${isCloseArmed ? "is-armed-close" : ""}`} onPointerDown={stopButtonPointer} onClick={close} aria-label={isCloseArmed ? t("canvas.frame.confirmCloseAria", { title: displayTitle }) : t("canvas.frame.closeAria", { title: displayTitle })} title={isCloseArmed ? t("canvas.frame.confirmCloseTitle") : t("canvas.frame.closeTitle")}>
            {isCloseArmed ? t("canvas.frame.closeArmed") : <CloseIcon />}
          </button>
        </div>
      </div>
      {/* 무장 중에는 Alt를 놓아도 안내가 남아야 한다 — 확인 기한이 1.5초뿐이라 Alt를 다시 눌러 확인할 시간이 없다. */}
      <div className={`canvas-operation-glance-hud${glanceHud.armedMessageKey ? " is-armed-set-aside" : ""}`} aria-hidden="true">
        <div className="canvas-operation-glance-hud-name">
          <span className="canvas-operation-glance-hud-index">{glanceHud.index}</span>
          <span>{displayTitle}</span>
        </div>
        {glanceHud.armedMessageKey ? (
          <div className="canvas-operation-glance-hud-arm">{t(glanceHud.armedMessageKey)}</div>
        ) : glanceHud.hints.length > 0 ? (
          <div className="canvas-operation-glance-hud-keys">
            {glanceHud.hints.map((hint) => (
              <span key={hint.key}><strong>{hint.key}</strong> {t(hint.messageKey)}</span>
            ))}
          </div>
        ) : null}
      </div>
      <div ref={terminalRef} className="canvas-operation-terminal" onPointerDown={stopOperationPointer} onWheel={stopOperationWheel} data-canvas-blocker>
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
          onLostPointerCapture={abortPointerManipulation}
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
