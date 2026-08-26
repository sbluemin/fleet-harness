import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent as ReactWheelEvent } from "react";

import { CaptionTipHost } from "@fleet-console/sdk/components/caption-actions";
import type { OperationNode, OperationGeometry } from "@fleet-console/sdk/operations";

import { useT } from "../i18n/index.js";
import { operationActivityVisual, type OperationActivityVisual } from "../operation-activity.js";
import { useInlineRename } from "../use-inline-rename.js";
import type { GlanceHudModel } from "./glance-hud.js";
import { resolveAccentColor } from "./operation-accent.js";

interface OperationFrameProps {
  readonly operation: OperationNode;
  readonly active: boolean;
  readonly unseen: boolean;
  readonly geometry: OperationGeometry;
  readonly zoom: number;
  readonly status?: OperationActivityVisual;
  readonly minimized?: boolean;
  readonly maximized?: boolean;
  readonly renderHidden?: boolean;
  readonly focusLayerTarget?: boolean;
  readonly topEdge?: boolean;
  readonly interactionDisabled?: boolean;
  readonly triageStage?: boolean;
  readonly triagePicked?: boolean;
  /** War Room 덱의 한 칸에 선 패널 — 자리와 크기를 칸이 정하므로 캔버스 좌표를 쓰지 않는다. */
  readonly deckTile?: boolean;
  readonly glanceHud: GlanceHudModel;
  readonly accentKey?: string | null;
  readonly groupName?: string | null;
  readonly groupColor?: string | null;
  /** Shell 캡션의 소속 Theater. 저장 제목과 별개라 Theater 이름이 바뀌어도 따라간다. */
  readonly theaterLabel?: string | null;
  readonly children: ReactNode;
  /**
   * 캡션 동작 선반 — 이 Operation의 플러그인이 채우는 마크 버튼들. 자리는 프레임이 정한다:
   * 메뉴 버튼 왼쪽, 창 컨트롤 앞. 덱 타일에서는 부모가 아예 넘기지 않는다(카드 본문은 inert라
   * 동작하지 않는 버튼이 서면 거짓 약속이 된다).
   */
  readonly captionActions?: ReactNode;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onMinimize: () => void;
  readonly onMaximize?: () => void;
  readonly onRename: (title: string) => void;
  /** 캡션 More 버튼이 여는 Operation 메뉴 — 사이드바 우클릭과 같은 메뉴를 부모가 소유한다. */
  readonly onOpenMenu?: (anchor: DOMRect, returnFocus: HTMLElement | null) => void;
  /**
   * 이 프레임이 focus layer 뒤로 숨을 때의 통지. 메뉴는 부모 소유이고 프레임은 자기가 숨는 것만
   * 아므로, 보이지 않는 패널의 메뉴가 화면에 남지 않도록 부모가 이 신호로 자기 메뉴를 거둔다.
   */
  readonly onRenderHiddenDismissMenu?: () => void;
  readonly onGeometryChange: (geometry: OperationGeometry) => void;
  readonly onGeometryCommit: (geometry: OperationGeometry) => void;
  readonly onRenderHiddenFocus?: () => void;
}

interface DragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly geometry: OperationGeometry;
  capturing: boolean;
  latest: OperationGeometry;
}

interface ResizeState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly geometry: OperationGeometry;
  readonly direction: ResizeDirection;
  latest: OperationGeometry;
}

type ResizeDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

const RESIZE_DIRECTIONS: readonly ResizeDirection[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
const MIN_OPERATION_WIDTH = 320;
const MIN_OPERATION_HEIGHT = 200;
const CLOSE_ARM_DURATION_MS = 1500;
const DRAG_THRESHOLD_PX = 3;
// 캡션 상태 레일의 도착 플래시 길이 — CSS의 var(--duration-slow)와 한 값이다.
const ARRIVAL_FLASH_DURATION_MS = 360;
// 포커스 도착 링의 수명 — CSS --duration-slow(0.36s)와 같은 값이다. 링은 전이 전용이라
// 애니메이션이 끝나면 클래스를 거둔다.
const FOCUS_ARRIVAL_DURATION_MS = 360;
// 위상을 한 박자로 묶는 레일 애니메이션 — components.css의 상태 레일 선언과 한 벌이다.
const PHASE_LOCKED_RAIL_ANIMATIONS = new Set(["caption-rail-flow", "caption-rail-call", "caption-rail-tide"]);

export function OperationFrame({ operation, active, unseen, geometry, zoom, status, minimized = false, maximized = false, renderHidden = false, focusLayerTarget = false, topEdge = false, interactionDisabled = false, triageStage = false, triagePicked = false, deckTile = false, glanceHud, accentKey = null, groupName = null, groupColor = null, theaterLabel = null, children, captionActions = null, onActivate, onClose, onMinimize, onMaximize, onRename, onOpenMenu, onRenderHiddenDismissMenu, onGeometryChange, onGeometryCommit, onRenderHiddenFocus }: OperationFrameProps) {
  const t = useT();
  const operationRef = useRef<HTMLElement | null>(null);
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const identityTriggerRef = useRef<HTMLButtonElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const closeArmTimeoutRef = useRef<number | null>(null);
  const arrivalFlashTimeoutRef = useRef<number | null>(null);
  const focusArrivalTimeoutRef = useRef<number | null>(null);
  // 마운트 시점의 unseen을 이전 값으로 삼는다 — 이미 미확인인 채로 되살아난 프레임(Theater 재진입 등)은
  // 새 도착이 아니므로 플래시하지 않는다.
  const previousUnseenRef = useRef(unseen);
  // 마운트 시점의 active를 이전 값으로 삼는다 — 이미 포커스를 쥔 채 되살아난 프레임(Theater
  // 재진입·보기 모드 전환)은 이동이 아니므로 링을 돌리지 않는다.
  const previousActiveRef = useRef(active);
  const lastVisibleGeometryRef = useRef(geometry);
  const restoreIdentityFocusRef = useRef(false);
  const [isCloseArmed, setIsCloseArmed] = useState(false);
  const [arrivalFlash, setArrivalFlash] = useState(false);
  const [focusArrival, setFocusArrival] = useState(false);
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
  // 사용자 accent(정체성)는 명판 마크만 소유한다. 캡션 채움은 액센트가 없을 때와 같다.
  // 패널 보더/글로우/비콘은 상태 채널(brass 포커스·aurora 대기·coral 위험) 전용이다.
  const accentColor = accentKey ? resolveAccentColor(accentKey) : null;
  // 그룹 소속은 개인 accent와 다른 축이므로 자기 마크(도트)와 중립 티어 이름으로 따로 선다 —
  // 색은 도트만 지고 이름은 캡션의 기존 중립 메타 티어를 그대로 상속한다.
  const groupLabelVisible = Boolean(groupName && groupColor);
  const theaterLabelVisible = Boolean(theaterLabel);
  const className = [
    "canvas-operation",
    unseen ? "is-unseen" : "",
    arrivalFlash ? "is-unseen-arriving" : "",
    focusArrival ? "is-focus-arriving" : "",
    active ? "is-active" : "",
    minimized ? "is-minimized" : "",
    maximized ? "is-maximized" : "",
    triageStage ? "is-triage-stage" : "",
    deckTile ? "is-deck-tile" : "",
    topEdge ? "is-top-edge" : "",
    dragging ? "is-dragging" : "",
    frameStatusClass(status),
  ].filter(Boolean).join(" ");

  useEffect(() => () => {
    if (closeArmTimeoutRef.current !== null) window.clearTimeout(closeArmTimeoutRef.current);
    if (arrivalFlashTimeoutRef.current !== null) window.clearTimeout(arrivalFlashTimeoutRef.current);
    if (focusArrivalTimeoutRef.current !== null) window.clearTimeout(focusArrivalTimeoutRef.current);
  }, []);

  // 포커스가 이 패널로 옮겨 앉는 순간에만 링을 돌린다 — 상태의 존재가 아니라 전이다.
  // 포커스를 잃는 쪽은 아무것도 돌리지 않는다: 이동은 도착지 하나로 읽혀야 한다.
  useEffect(() => {
    const previous = previousActiveRef.current;
    previousActiveRef.current = active;
    if (previous || !active) return;
    if (focusArrivalTimeoutRef.current !== null) window.clearTimeout(focusArrivalTimeoutRef.current);
    setFocusArrival(true);
    focusArrivalTimeoutRef.current = window.setTimeout(() => {
      focusArrivalTimeoutRef.current = null;
      setFocusArrival(false);
    }, FOCUS_ARRIVAL_DURATION_MS);
  }, [active]);

  // 도착은 상태의 전이이지 상태의 존재가 아니다 — false → true로 넘어가는 순간에만 플래시한다.
  useEffect(() => {
    const previous = previousUnseenRef.current;
    previousUnseenRef.current = unseen;
    if (previous || !unseen) return;
    if (arrivalFlashTimeoutRef.current !== null) window.clearTimeout(arrivalFlashTimeoutRef.current);
    setArrivalFlash(true);
    arrivalFlashTimeoutRef.current = window.setTimeout(() => {
      arrivalFlashTimeoutRef.current = null;
      setArrivalFlash(false);
    }, ARRIVAL_FLASH_DURATION_MS);
  }, [unseen]);

  // 같은 상태의 레일은 한 박자로 뛴다 — CSS 애니메이션의 위상은 그 요소가 상태에 들어간 시각에
  // 묶인다. 패널마다 진입 시각이 다르면 같은 순간의 밝기가 갈려(실측: 0.45 대 0.78) 화면이
  // 제각각 깜빡이는 반딧불이가 된다. 상태가 바뀔 때 레일 애니메이션의 시작을 문서 타임라인
  // 원점으로 옮겨 위상을 하나로 맞춘다. turn의 트래블과 도착 플래시는 제외한다 — 앞의 것은
  // 진행 위치를 말하는 왕복이고, 뒤의 것은 상태가 아니라 전이라 겹쳐 뛰면 안 된다.
  useEffect(() => {
    const frame = operationRef.current;
    if (!frame || typeof frame.getAnimations !== "function") return;
    for (const animation of frame.getAnimations({ subtree: true })) {
      if (!PHASE_LOCKED_RAIL_ANIMATIONS.has((animation as CSSAnimation).animationName)) continue;
      animation.startTime = 0;
    }
  }, [status, unseen]);

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

  // focus layer가 현재 포커스를 담은 peer를 숨길 때는 body로 흘려보내지 않고 새 전면 frame으로 옮긴다.
  // Map 바다는 싱크가 아니다 — 전면 프레임이 없으면 브라우저가 inert peer에서 포커스를 걷는다.
  // 메뉴 회수를 포커스 이관보다 먼저 한다 — 뒤에 두면 부모가 메뉴를 닫으며 되돌리는 포커스가
  // 방금 inert가 된 이 프레임의 트리거를 향한다.
  useLayoutEffect(() => {
    if (!renderHidden || typeof document === "undefined") return;
    onRenderHiddenDismissMenu?.();
    if (operationRef.current?.contains(document.activeElement)) onRenderHiddenFocus?.();
  }, [renderHidden, onRenderHiddenDismissMenu, onRenderHiddenFocus]);

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

  // 캡처가 포인터업 없이 끊기면(언마운트·lostpointercapture) 라이브 좌표를 커밋한다.
  // 버리면 Station Keeping이 정착하지 못해 캡션이 이웃 위에 겹친 채 멈춘다.
  const finishPointerManipulation = (shouldCommit: boolean) => {
    const drag = dragRef.current;
    const resize = resizeRef.current;
    if (!drag && !resize) return;
    dragRef.current = null;
    resizeRef.current = null;
    setDragging(false);
    if (!shouldCommit) return;
    if (drag?.capturing) onGeometryCommit(drag.latest);
    else if (resize) onGeometryCommit(resize.latest);
  };

  // 드래그/리사이즈 도중 캡처 대상이 언마운트되면 pointerup이 오지 않는다.
  // is-dragging을 걷고, 움직인 좌표는 정착 경로로 넘긴다.
  useEffect(() => {
    if (!maximized && !interactionDisabled && !minimized) return;
    finishPointerManipulation(true);
  }, [maximized, interactionDisabled, minimized]);

  const abortPointerManipulation = () => {
    finishPointerManipulation(true);
  };

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    disarmClose();
    if (maximized || interactionDisabled) return;
    if (event.button !== 0) return;
    event.stopPropagation();
    onActivate();
    // 제자리 클릭·더블클릭은 캡처하지 않는다 — 캡처하면 제목 버튼의 dblclick이 캡션으로 간다.
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, geometry, latest: geometry, capturing: false };
  };

  const updateDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (maximized || interactionDisabled) return;
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.capturing) {
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
      drag.capturing = true;
      setDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    event.stopPropagation();
    const next = {
      ...drag.geometry,
      x: drag.geometry.x + dx / zoom,
      y: drag.geometry.y + dy / zoom,
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
    const moved = drag.capturing;
    dragRef.current = null;
    setDragging(false);
    if (moved) {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.releasePointerCapture(event.pointerId);
      onGeometryCommit(drag.latest);
    }
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
    // 이름 입력 중만 드래그를 막는다. 제목 버튼은 캡션과 같이 창을 움직인다.
    if (rename.renaming) event.stopPropagation();
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

  const openOperationMenu = (anchor: DOMRect, returnFocus: HTMLElement | null) => {
    disarmClose();
    onActivate();
    onOpenMenu?.(anchor, returnFocus);
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
  // 덱 칸에 선 패널은 자리도 크기도 칸이 정한다 — 캔버스 좌표를 인라인으로 실으면 grid 칸 안에서
  // 그 값이 그대로 살아나 패널이 칸을 넘치거나 어긋난 자리에 선다.
  const frameStyle = deckTile ? {
    ...(renderHidden ? { visibility: "hidden", pointerEvents: "none" } : {}),
    ...(accentColor ? { "--user-accent": accentColor } : {}),
  } as CSSProperties : {
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
      aria-label={t("canvas.frame.operationAria", {
        title: displayTitle,
        groupContext: groupLabelVisible ? t("canvas.frame.inGroup", { name: groupName ?? "" }) : "",
      }) + (theaterLabelVisible ? t("canvas.frame.inTheater", { name: theaterLabel ?? "" }) : "")}
      aria-hidden={renderHidden || undefined}
      tabIndex={focusLayerTarget ? -1 : undefined}
      inert={minimized || renderHidden ? true : undefined}
    >
      <div
        className="canvas-operation-titlebar"
        onPointerDown={beginDrag}
        onPointerMove={updateDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={abortPointerManipulation}
        data-canvas-blocker
      >
        {groupLabelVisible ? (
          <span
            className="canvas-operation-group-label"
            style={{ "--group-mark": groupColor } as CSSProperties}
            title={t("canvas.frame.groupTitle", { name: groupName ?? "" })}
            aria-hidden="true"
          >
            <span className="canvas-operation-group-dot" />
            <span className="canvas-operation-group-name">{groupName}</span>
          </span>
        ) : null}
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
        {theaterLabelVisible ? (
          <span
            className="canvas-operation-theater-label"
            title={t("canvas.frame.theaterTitle", { name: theaterLabel ?? "" })}
            aria-hidden="true"
          >
            {theaterLabel}
          </span>
        ) : null}
        {triagePicked ? <span className="canvas-operation-triage-picked">{t("canvas.triage.picked")}</span> : null}
        {/* 캡션은 상태를 말하지 않는다 — 패널 자신의 보더·글로우가 이미 상태 채널을 지고 있고,
            목록에서 상태를 읽는 자리는 사이드바 칩이다. 이 자리는 그 Operation에 대한 동작을
            여는 문(사이드바 우클릭과 같은 메뉴)이 가져간다. */}
        {/* 플러그인 동작 선반 — 이 줄에서 마크만 서는 버튼은 전부 같은 말풍선을 쓴다. */}
        {captionActions ? <span className="canvas-operation-caption-actions">{captionActions}</span> : null}
        {onOpenMenu ? (
          <CaptionTipHost label={t("canvas.frame.openMenuTitle")}>
            <button
              type="button"
              className="canvas-operation-more-button"
              onPointerDown={stopButtonPointer}
              onClick={(event) => openOperationMenu(event.currentTarget.getBoundingClientRect(), event.currentTarget)}
              aria-label={t("canvas.frame.openMenuAria", { title: displayTitle })}
              aria-haspopup="menu"
            >
              <MoreIcon />
            </button>
          </CaptionTipHost>
        ) : null}
        <div className="canvas-operation-window-controls">
          <span className="canvas-operation-controls-divider" aria-hidden="true" />
          {/* 최소화는 무대에서도 쓴다 — War Room의 최소화는 창을 접는 동작이 아니라 판(deck)에서
              내리는 동작이고, 무대에 선 패널이면 무대까지 함께 비운다. 최대화만 계속 빠진다:
              무대는 이미 캔버스 전체라 더 키울 자리가 없다. */}
          <CaptionTipHost label={t("canvas.frame.minimizeTitle")}>
            <button type="button" className="canvas-operation-icon-button" onPointerDown={stopButtonPointer} onClick={minimize} aria-label={t("canvas.frame.minimizeAria", { title: displayTitle })}>
              <MinimizeIcon />
            </button>
          </CaptionTipHost>
          {!triageStage && !deckTile && onMaximize ? (
            <CaptionTipHost label={maximized ? t("canvas.frame.restoreTitle") : t("canvas.frame.maximizeTitle")}>
              <button type="button" className={`canvas-operation-icon-button ${maximized ? "is-active" : ""}`} onPointerDown={stopButtonPointer} onClick={maximize} aria-label={maximized ? t("canvas.frame.restoreAria", { title: displayTitle }) : t("canvas.frame.maximizeAria", { title: displayTitle })} aria-pressed={maximized}>
                {maximized ? <RestorePanelIcon /> : <MaximizePanelIcon />}
              </button>
            </CaptionTipHost>
          ) : null}
          <CaptionTipHost label={isCloseArmed ? t("canvas.frame.confirmCloseTitle") : t("canvas.frame.closeTitle")}>
            <button type="button" className={`canvas-operation-icon-button ${isCloseArmed ? "is-armed-close" : ""}`} onPointerDown={stopButtonPointer} onClick={close} aria-label={isCloseArmed ? t("canvas.frame.confirmCloseAria", { title: displayTitle }) : t("canvas.frame.closeAria", { title: displayTitle })}>
              {isCloseArmed ? t("canvas.frame.closeArmed") : <CloseIcon />}
            </button>
          </CaptionTipHost>
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
      {/* 덱 칸에 선 패널의 본문은 읽는 자리다 — 승격 면이 포인터를 가로채는 것만으로는 절반이고,
          키보드는 그 면을 지나쳐 살아 있는 body(터미널 textarea·에이전트 컴포저)로 바로 들어간다.
          본문만 inert로 빼면 캡션의 창 컨트롤과 승격 면은 탭 순서에 그대로 남는다. */}
      <div ref={terminalRef} className="canvas-operation-terminal" onPointerDown={stopOperationPointer} onWheel={stopOperationWheel} data-canvas-blocker inert={deckTile ? true : undefined}>
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

function frameStatusClass(status: OperationActivityVisual | undefined): string {
  const visual = operationActivityVisual(status);
  if (visual === "running") return "is-running is-running--turn";
  if (visual === "background") return "is-running is-running--background";
  if (visual === "awaiting") return "is-running is-running--awaiting";
  return "";
}

function MoreIcon() {
  // 가로 3점 — 이 Operation에 대한 나머지 동작이 메뉴로 열린다는 표준 문법.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="4" cy="8" r="1.2" fill="currentColor" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" />
      <circle cx="12" cy="8" r="1.2" fill="currentColor" />
    </svg>
  );
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

export function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.6 4.6 11.4 11.4M11.4 4.6 4.6 11.4" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}
