import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from "react";

import type { OperationActivity } from "@fleet-console/sdk/plugin";
import type { OperationNode } from "../types.js";
import type { OperationNotification } from "../types.js";
import { dropIndexFromPoint } from "./canvas-dock-hit-test.js";
import { AccentPopover } from "./accent-popover.js";
import { operationAccentFromNode, resolveAccentColor } from "./operation-accent.js";
import { setOperationOrder, useCanvasState } from "./canvas-store.js";

interface CanvasDockProps {
  readonly operations: readonly OperationNode[];
  readonly minimized: readonly string[];
  readonly activeOperationId: string | null;
  readonly operationStatus: Readonly<Record<string, OperationActivity>>;
  readonly operationNotifications: Readonly<Record<string, OperationNotification>>;
  readonly onClose: (operationId: string) => void;
  readonly onFocus: (operationId: string) => void;
  readonly onSetAccent: (operationId: string, accentKey: string | null) => void;
}

interface AccentPopoverState {
  readonly operationId: string;
  readonly anchor: DOMRect;
}

interface DockEntry {
  readonly operation: OperationNode;
  readonly active: boolean;
  readonly minimized: boolean;
  readonly beaconClassName: string;
  readonly notificationCount: number;
  readonly underway: Underway;
  readonly showRing: boolean;
}

interface CanvasDockChipProps {
  readonly entry: DockEntry;
  readonly index: number;
  readonly isCloseArmed: boolean;
  readonly accentValue: string | null;
  readonly dragging: boolean;
  readonly dragOffsetX: number;
  readonly dropTarget: boolean;
  readonly onArmClose: (operationId: string) => void;
  readonly onDisarmClose: () => void;
  readonly onClose: (operationId: string) => void;
  readonly onFocus: (operationId: string) => void;
  readonly onKeyboardMove: (operationId: string, direction: -1 | 1) => void;
  readonly onPointerDragStart: (event: ReactPointerEvent<HTMLDivElement>, operationId: string) => void;
  readonly onPointerDragMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerDragEnd: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerDragCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onOpenAccent: (operationId: string, anchor: DOMRect) => void;
}

type Underway = "live" | "turn" | "awaiting" | null;

interface PagerState {
  readonly overflow: boolean;
  readonly atStart: boolean;
  readonly atEnd: boolean;
  readonly page: number;
  readonly pages: number;
}

interface DragState {
  readonly sourceId: string;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  // 현재 포인터 X — 끄는 칩이 커서를 따라 들려 이동(translateX)하게 해 "잡고 끌고 있다"는 감각을 준다.
  readonly currentX: number;
  readonly dragging: boolean;
  readonly dropIndex: number;
}

const INITIAL_PAGER: PagerState = { overflow: false, atStart: false, atEnd: true, page: 1, pages: 1 };
const CLOSE_ARM_DURATION_MS = 1500;
const DRAG_THRESHOLD_PX = 6;
const AUTO_SCROLL_EDGE_PX = 34;
const AUTO_SCROLL_STEP_PX = 18;

export function CanvasDock({ operations, minimized, activeOperationId, operationStatus, operationNotifications, onClose, onFocus, onSetAccent }: CanvasDockProps) {
  const chipsRef = useRef<HTMLDivElement | null>(null);
  const pinRightRef = useRef(true);
  const closeArmTimeoutRef = useRef<number | null>(null);
  const [pager, setPager] = useState<PagerState>(INITIAL_PAGER);
  const [armedCloseId, setArmedCloseId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [accentPopover, setAccentPopover] = useState<AccentPopoverState | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const canvas = useCanvasState();
  const minimizedSet = new Set(minimized);
  // 태스크바는 최소화 여부와 무관하게 현재 Theater의 모든 Operation을 표시한다.
  const entries: DockEntry[] = sortOperations(operations, canvas.operationOrder)
    .map((operation) => {
      const underway = resolveUnderway(operation.id, operationStatus, operationNotifications);
      return {
        operation,
        active: activeOperationId === operation.id,
        minimized: minimizedSet.has(operation.id),
        beaconClassName: beaconClassNameFor(underway, operationStatus[operation.id]),
        notificationCount: operationNotifications[operation.id]?.count ?? 0,
        underway,
        showRing: underway !== null && minimizedSet.has(operation.id),
      };
    });
  const entriesKey = entries.map((entry) => entry.operation.id).join(",");
  const metricsKey = entries.map((entry) => `${displayTitle(entry.operation)}\u0001${entry.notificationCount}`).join("\u0002");
  const currentOrder = entries.map((entry) => entry.operation.id);
  const dragSourceIndex = drag ? currentOrder.indexOf(drag.sourceId) : -1;

  const clearCloseArmTimer = useCallback(() => {
    if (closeArmTimeoutRef.current === null) return;
    window.clearTimeout(closeArmTimeoutRef.current);
    closeArmTimeoutRef.current = null;
  }, []);

  const disarmClose = useCallback(() => {
    clearCloseArmTimer();
    setArmedCloseId(null);
  }, [clearCloseArmTimer]);

  const armClose = useCallback((operationId: string) => {
    clearCloseArmTimer();
    setArmedCloseId(operationId);
    closeArmTimeoutRef.current = window.setTimeout(() => {
      closeArmTimeoutRef.current = null;
      setArmedCloseId(null);
    }, CLOSE_ARM_DURATION_MS);
  }, [clearCloseArmTimer]);

  const measure = useCallback(() => {
    const el = chipsRef.current;
    if (!el) return;
    const { scrollLeft, clientWidth, clientHeight, scrollWidth } = el;
    const maxScroll = Math.max(0, scrollWidth - clientWidth);
    const overflow = clientWidth > 0 && clientHeight > 0 && maxScroll > 1;
    const pages = overflow ? Math.max(1, Math.ceil(scrollWidth / clientWidth)) : 1;
    const atEnd = scrollLeft >= maxScroll - 1;
    const page = overflow ? (atEnd ? 1 : Math.min(pages, Math.ceil((maxScroll - scrollLeft) / clientWidth) + 1)) : 1;
    setPager({ overflow, atStart: scrollLeft <= 1, atEnd, page, pages });
  }, []);

  useEffect(() => {
    const el = chipsRef.current;
    if (!el) return;
    pinRightRef.current = true;
    el.scrollLeft = el.scrollWidth;
    measure();
    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          if (pinRightRef.current) el.scrollLeft = el.scrollWidth;
          measure();
        })
      : null;
    observer?.observe(el);
    const onScroll = () => {
      const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
      pinRightRef.current = el.scrollLeft >= maxScroll - 1;
      measure();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer?.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
  }, [entriesKey, measure]);

  useEffect(() => clearCloseArmTimer, [clearCloseArmTimer]);

  useEffect(() => {
    const el = chipsRef.current;
    if (!el) return;
    if (pinRightRef.current) el.scrollLeft = el.scrollWidth;
    measure();
  }, [metricsKey, measure]);

  useEffect(() => {
    if (armedCloseId === null) return;
    if (entries.some((entry) => entry.operation.id === armedCloseId)) return;
    disarmClose();
  }, [armedCloseId, entries, disarmClose]);

  if (entries.length === 0) return null;

  const showPager = pager.overflow;
  const turnPage = (direction: -1 | 1) => {
    const el = chipsRef.current;
    if (!el) return;
    const reduce = typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: direction * el.clientWidth, behavior: reduce ? "auto" : "smooth" });
  };
  const announceOrder = (operationId: string, targetIndex: number) => {
    const entry = entries.find((item) => item.operation.id === operationId);
    setStatusMessage(`${entry ? displayTitle(entry.operation) : "Operation"} moved to position ${targetIndex + 1} of ${entries.length}.`);
  };
  const keyboardMove = (operationId: string, direction: -1 | 1) => {
    const index = currentOrder.indexOf(operationId);
    if (index === -1) return;
    const targetIndex = Math.max(0, Math.min(currentOrder.length - 1, index + direction));
    if (targetIndex === index) return;
    const nextOrder = [...currentOrder];
    const [moved] = nextOrder.splice(index, 1);
    if (moved === undefined) return;
    nextOrder.splice(targetIndex, 0, moved);
    setOperationOrder(nextOrder);
    announceOrder(operationId, targetIndex);
  };
  const beginPointerDrag = (event: ReactPointerEvent<HTMLDivElement>, operationId: string) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setAccentPopover(null);
    disarmClose();
    setDrag({ sourceId: operationId, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, currentX: event.clientX, dragging: false, dropIndex: currentOrder.indexOf(operationId) });
  };
  const updatePointerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.dragging && distance < DRAG_THRESHOLD_PX) return;
    const dropIndex = dropIndexFromPoint(event.clientX, currentOrder, chipsRef.current, drag.sourceId);
    autoScrollDock(event.clientX, chipsRef.current);
    setDrag({ ...drag, currentX: event.clientX, dragging: true, dropIndex });
  };
  const finishPointerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const { sourceId, dragging, dropIndex } = drag;
    setDrag(null);
    if (!dragging) return;
    const sourceIndex = currentOrder.indexOf(sourceId);
    if (sourceIndex === -1 || dropIndex === sourceIndex) return;
    const nextOrder = reorderIds(currentOrder, sourceId, dropIndex);
    setOperationOrder(nextOrder);
    announceOrder(sourceId, nextOrder.indexOf(sourceId));
  };
  const cancelPointerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDrag(null);
  };
  // 팝업 대상 Operation이 닫히거나 Theater 전환으로 사라지면 팝업도 함께 닫힌다(아래 렌더 가드).
  const popoverOperation = accentPopover ? entries.find((entry) => entry.operation.id === accentPopover.operationId)?.operation ?? null : null;

  return (
    <div className="canvas-dock is-taskbar" data-canvas-blocker>
      <div className="canvas-dock-rail" role="toolbar" aria-label="Open operations">
        {showPager ? (
          <button type="button" className="canvas-dock-pager canvas-dock-pager--prev" onClick={() => turnPage(-1)} disabled={pager.atStart} aria-label="Show older operations" title="Older">
            <PagerCaret direction="prev" />
          </button>
        ) : null}
        <div className="canvas-dock-chips" ref={chipsRef}>
          {entries.map((entry, index) => {
            const accentKey = canvas.operationAccent[entry.operation.id] ?? operationAccentFromNode(entry.operation);
            const accentValue = accentKey ? resolveAccentColor(accentKey) : null;
            return (
              <CanvasDockChip
                key={entry.operation.id}
                entry={entry}
                index={index}
                isCloseArmed={armedCloseId === entry.operation.id}
                accentValue={accentValue}
                dragging={drag?.sourceId === entry.operation.id && drag.dragging}
                dragOffsetX={drag?.sourceId === entry.operation.id && drag.dragging ? drag.currentX - drag.startX : 0}
                dropTarget={drag?.dragging === true && drag.dropIndex === index && dragSourceIndex !== index}
                onArmClose={armClose}
                onDisarmClose={disarmClose}
                onClose={onClose}
                onFocus={onFocus}
                onKeyboardMove={keyboardMove}
                onPointerDragStart={beginPointerDrag}
                onPointerDragMove={updatePointerDrag}
                onPointerDragEnd={finishPointerDrag}
                onPointerDragCancel={cancelPointerDrag}
                onOpenAccent={(operationId, anchor) => setAccentPopover({ operationId, anchor })}
              />
            );
          })}
        </div>
        {showPager ? (
          <button type="button" className="canvas-dock-pager canvas-dock-pager--next" onClick={() => turnPage(1)} disabled={pager.atEnd} aria-label="Show newer operations" title="Newer">
            <PagerCaret direction="next" />
          </button>
        ) : null}
        {showPager ? <span className="canvas-dock-page" aria-label={`Page ${pager.page} of ${pager.pages}`}>{pager.page}/{pager.pages}</span> : null}
        <span className="sr-only" aria-live="polite">{statusMessage}</span>
      </div>
      {accentPopover && popoverOperation ? (
        <AccentPopover
          anchor={accentPopover.anchor}
          accentKey={canvas.operationAccent[popoverOperation.id] ?? operationAccentFromNode(popoverOperation)}
          onSelect={(accentKey) => onSetAccent(popoverOperation.id, accentKey)}
          onClose={() => setAccentPopover(null)}
        />
      ) : null}
    </div>
  );
}

function CanvasDockChip({
  entry,
  index,
  isCloseArmed,
  accentValue,
  dragging,
  dragOffsetX,
  dropTarget,
  onArmClose,
  onDisarmClose,
  onClose,
  onFocus,
  onKeyboardMove,
  onPointerDragStart,
  onPointerDragMove,
  onPointerDragEnd,
  onPointerDragCancel,
  onOpenAccent,
}: CanvasDockChipProps) {
  const suppressClickRef = useRef(false);
  const { operation, active, minimized, beaconClassName, notificationCount, underway } = entry;
  const title = displayTitle(operation);
  const chipClassName = [
    "canvas-dock-chip",
    active ? "canvas-dock-chip--active" : "",
    minimized ? "canvas-dock-chip--minimized" : "",
    underway ? `canvas-dock-chip--underway canvas-dock-chip--underway-${underway}` : "",
    entry.showRing ? "canvas-dock-chip--underway-ring" : "",
    dragging ? "canvas-dock-chip--dragging" : "",
    dropTarget ? "canvas-dock-chip--drop-target" : "",
  ].filter(Boolean).join(" ");
  const closeClassName = [
    "canvas-dock-chip-close",
    isCloseArmed ? "is-armed" : "",
  ].filter(Boolean).join(" ");
  const chipStyle = {
    "--i": index,
    ...(accentValue ? { "--chip-accent": accentValue } : {}),
    ...(dragging ? { "--drag-dx": `${Math.round(dragOffsetX)}px` } : {}),
  } as CSSProperties;

  const focus = () => {
    onDisarmClose();
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onFocus(operation.id);
  };
  const stopClosePointer = (event: SyntheticEvent<HTMLButtonElement>) => { event.stopPropagation(); };
  const close = (event: SyntheticEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!isCloseArmed) {
      onArmClose(operation.id);
      return;
    }
    onDisarmClose();
    onClose(operation.id);
  };
  // beacon(좌측 인디케이터) 클릭 = accent 팝업 열기. 칩 focus/restore로 버블되지 않게 stopPropagation한다
  // (최소화 패널은 이 인디케이터가 accent 설정의 유일한 진입점이다).
  const openAccent = (event: SyntheticEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onOpenAccent(operation.id, event.currentTarget.getBoundingClientRect());
  };

  return (
    <div
      data-dock-chip-id={operation.id}
      className={chipClassName}
      role="button"
      tabIndex={0}
      aria-label={active ? `${title} (focused)` : `Focus operation ${title}`}
      aria-current={active ? "true" : undefined}
      title={active ? "Focused" : "Click to focus"}
      style={chipStyle}
      onClick={focus}
      onFocus={() => {
        if (!isCloseArmed) onDisarmClose();
      }}
      onPointerDown={(event) => onPointerDragStart(event, operation.id)}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onPointerUp={(event) => {
        if (dragging) suppressClickRef.current = true;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        // 재배치는 Alt+Shift+←/→ — shift 없는 Alt+←/→는 operations의 Operation 순환이 가져간다(전역 capture 핸들러).
        if (event.altKey && event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
          event.preventDefault();
          onKeyboardMove(operation.id, event.key === "ArrowLeft" ? -1 : 1);
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          focus();
        }
      }}
      onPointerMoveCapture={(event) => onPointerDragMove(event)}
      onPointerUpCapture={(event) => onPointerDragEnd(event)}
      onPointerCancelCapture={(event) => onPointerDragCancel(event)}
    >
      <button type="button" className="canvas-dock-chip-beacon-button" onPointerDown={stopClosePointer} onClick={openAccent} aria-label={`Set accent for operation ${title}`} aria-haspopup="menu" title="Set accent">
        <span className={beaconClassName} aria-hidden="true" />
      </button>
      <span className="canvas-dock-chip-name">{title}</span>
      {notificationCount > 0 ? <span className="canvas-dock-chip-count">{notificationCount}</span> : null}
      <button type="button" className={closeClassName} onPointerDown={stopClosePointer} onClick={close} aria-label={isCloseArmed ? `Confirm close operation ${title}` : `Close operation ${title}`} title={isCloseArmed ? "Confirm close" : "Close operation"}>
        {isCloseArmed ? "Close?" : <CloseIcon />}
      </button>
    </div>
  );
}

function displayTitle(operation: OperationNode): string {
  return operation.renamedTitle ?? operation.title;
}

function sortOperations(operations: readonly OperationNode[], operationOrder: readonly string[]): readonly OperationNode[] {
  if (operationOrder.length === 0) return [...operations].sort(compareOperationCreatedAt);
  const explicitOrder = new Map(operationOrder.map((id, index) => [id, index]));
  return [...operations].sort((left, right) => {
    const leftIndex = explicitOrder.get(left.id);
    const rightIndex = explicitOrder.get(right.id);
    if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex;
    if (leftIndex !== undefined) return -1;
    if (rightIndex !== undefined) return 1;
    return compareOperationCreatedAt(left, right);
  });
}

function compareOperationCreatedAt(left: OperationNode, right: OperationNode): number {
  return left.ts.createdAt - right.ts.createdAt || left.id.localeCompare(right.id);
}

function resolveUnderway(
  operationId: string,
  operationStatus: Readonly<Record<string, OperationActivity>>,
  operationNotifications: Readonly<Record<string, OperationNotification>>,
): Underway {
  const status = operationStatus[operationId];
  if (operationNotifications[operationId]?.kind === "input-waiting" || status === "awaiting") return "awaiting";
  if (status === "running") return "turn";
  if (status === "live") return "live";
  return null;
}

function beaconClassNameFor(underway: Underway, status: OperationActivity | undefined): string {
  if (underway === "turn") return "tenant-beacon is-turn-running";
  if (underway === "awaiting") return "tenant-beacon is-turn-ended";
  if (status === "dormant") return "tenant-beacon is-dormant";
  return "tenant-beacon is-live";
}

// 전체 가시 순서(source 포함)에서 source를 dropIndex 자리로 옮긴 새 순서를 만든다. dropIndex는
// dropIndexFromPoint가 준 "이 인덱스 앞에 삽입" 값이라, source 제거로 뒤쪽 인덱스가 한 칸 당겨지면 보정한다.
function reorderIds(orderedIds: readonly string[], sourceId: string, dropIndex: number): string[] {
  const sourceIndex = orderedIds.indexOf(sourceId);
  if (sourceIndex === -1) return [...orderedIds];
  const next = orderedIds.filter((id) => id !== sourceId);
  const insertAt = dropIndex > sourceIndex ? dropIndex - 1 : dropIndex;
  const bounded = Math.max(0, Math.min(insertAt, next.length));
  next.splice(bounded, 0, sourceId);
  return next;
}

function autoScrollDock(clientX: number, chipsElement: HTMLDivElement | null): void {
  if (!chipsElement) return;
  const rect = chipsElement.getBoundingClientRect();
  if (clientX < rect.left + AUTO_SCROLL_EDGE_PX) {
    chipsElement.scrollLeft -= AUTO_SCROLL_STEP_PX;
  } else if (clientX > rect.right - AUTO_SCROLL_EDGE_PX) {
    chipsElement.scrollLeft += AUTO_SCROLL_STEP_PX;
  }
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.6 4.6 11.4 11.4M11.4 4.6 4.6 11.4" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}

function PagerCaret({ direction }: { readonly direction: "prev" | "next" }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d={direction === "prev" ? "M10 3.5 5.5 8 10 12.5" : "M6 3.5 10.5 8 6 12.5"} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
