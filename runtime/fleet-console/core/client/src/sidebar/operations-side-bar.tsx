import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { OperationCatalogPlugin, OperationLaunchKind } from "@fleet-console/sdk/operations";

import type { OperationNode, OperationNotification } from "../types.js";
import { AccentPopover } from "../canvas/accent-popover.js";
import { CanvasContextMenu } from "../canvas/canvas-context-menu.js";
import { operationAccentFromNode, resolveAccentColor } from "../canvas/operation-accent.js";
import { setOperationOrder, useCanvasState } from "../canvas/canvas-store.js";
import { dropIndexFromPoint } from "./operations-side-bar-hit-test.js";
import { OperationsSideBarChip, type SideBarEntry } from "./operations-side-bar-chip.js";
import { MIN_RAIL_PX, setSideBarCollapsed, setSideBarWidth, tierFromWidth, useSideBarState } from "./operations-side-bar-store.js";

interface OperationsSideBarProps {
  readonly operations: readonly OperationNode[];
  readonly minimized: readonly string[];
  readonly activeOperationId: string | null;
  readonly operationNotifications: Readonly<Record<string, OperationNotification>>;
  readonly catalog: readonly OperationCatalogPlugin[];
  readonly canLaunch: boolean;
  readonly mapFullscreen: boolean;
  readonly radarEnabled: boolean;
  readonly perimeterEnabled: boolean;
  readonly renderKindIcon: (pluginId: string, kind: OperationLaunchKind) => ReactNode;
  readonly onLaunchKind: (pluginId: string, kind: OperationLaunchKind) => void;
  readonly onResetView: () => void;
  readonly onMaximizeMap: () => void;
  readonly onToggleRadar: () => void;
  readonly onTogglePerimeter: () => void;
  readonly onClose: (operationId: string) => void;
  readonly onFocus: (operationId: string) => void;
  readonly onSetAccent: (operationId: string, accentKey: string | null) => void;
}

interface AccentPopoverState {
  readonly operationId: string;
  readonly anchor: DOMRect;
}

interface NewMenuState {
  readonly anchor: { readonly x: number; readonly y: number };
  readonly viewportBounds?: { readonly width: number; readonly height: number };
}

interface DragState {
  readonly sourceId: string;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly currentY: number;
  readonly dragging: boolean;
  readonly dropIndex: number;
}

const CLOSE_ARM_DURATION_MS = 1500;
const DRAG_THRESHOLD_PX = 6;
const AUTO_SCROLL_EDGE_PX = 34;
const AUTO_SCROLL_STEP_PX = 18;

export function OperationsSideBar({
  operations,
  minimized,
  activeOperationId,
  operationNotifications,
  catalog,
  canLaunch,
  mapFullscreen,
  radarEnabled,
  perimeterEnabled,
  renderKindIcon,
  onLaunchKind,
  onResetView,
  onMaximizeMap,
  onToggleRadar,
  onTogglePerimeter,
  onClose,
  onFocus,
  onSetAccent,
}: OperationsSideBarProps) {
  const chipsRef = useRef<HTMLOListElement | null>(null);
  const sideBar = useSideBarState();
  const { width, collapsed } = sideBar;
  const tier = collapsed ? "rail" : tierFromWidth(width);
  const canvas = useCanvasState();
  const closeArmTimeoutRef = useRef<number | null>(null);
  const [armedCloseId, setArmedCloseId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [accentPopover, setAccentPopover] = useState<AccentPopoverState | null>(null);
  const [newMenu, setNewMenu] = useState<NewMenuState | null>(null);
  const [settingsMenu, setSettingsMenu] = useState<NewMenuState | null>(null);
  const [statusMessage, setStatusMessage] = useState("");

  const minimizedSet = new Set(minimized);
  const entries: SideBarEntry[] = sortOperations(operations, canvas.operationOrder).map((operation) => {
    const kind = catalog.find((p) => p.id === operation.pluginId)?.kinds.find((k) => k.type === operation.type) ?? null;
    const icon = kind ? renderKindIcon(operation.pluginId, kind) : null;
    return {
      operation,
      active: activeOperationId === operation.id,
      minimized: minimizedSet.has(operation.id),
      notificationCount: operationNotifications[operation.id]?.count ?? 0,
      icon,
    };
  });
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

  const armClose = useCallback(
    (operationId: string) => {
      clearCloseArmTimer();
      setArmedCloseId(operationId);
      closeArmTimeoutRef.current = window.setTimeout(() => {
        closeArmTimeoutRef.current = null;
        setArmedCloseId(null);
      }, CLOSE_ARM_DURATION_MS);
    },
    [clearCloseArmTimer],
  );

  useEffect(() => clearCloseArmTimer, [clearCloseArmTimer]);

  useEffect(() => {
    if (armedCloseId === null) return;
    if (entries.some((entry) => entry.operation.id === armedCloseId)) return;
    disarmClose();
  }, [armedCloseId, entries, disarmClose]);

  const popoverOperation = accentPopover
    ? entries.find((entry) => entry.operation.id === accentPopover.operationId)?.operation ?? null
    : null;

  const announceOrder = (operationId: string, targetIndex: number) => {
    const entry = entries.find((item) => item.operation.id === operationId);
    setStatusMessage(
      `${entry ? (entry.operation.renamedTitle ?? entry.operation.title) : "Operation"} moved to position ${targetIndex + 1} of ${entries.length}.`,
    );
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

  const beginPointerDrag = (event: ReactPointerEvent<HTMLLIElement>, operationId: string) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setAccentPopover(null);
    disarmClose();
    setDrag({
      sourceId: operationId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      currentY: event.clientY,
      dragging: false,
      dropIndex: currentOrder.indexOf(operationId),
    });
  };

  const updatePointerDrag = (event: ReactPointerEvent<HTMLLIElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.dragging && distance < DRAG_THRESHOLD_PX) return;
    const dropIndex = dropIndexFromPoint(event.clientY, currentOrder, chipsRef.current, drag.sourceId);
    autoScrollSideBar(event.clientY, chipsRef.current);
    setDrag({ ...drag, currentY: event.clientY, dragging: true, dropIndex });
  };

  const finishPointerDrag = (event: ReactPointerEvent<HTMLLIElement>) => {
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

  const cancelPointerDrag = (event: ReactPointerEvent<HTMLLIElement>) => {
    if (drag && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDrag(null);
  };

  const handleResizeDragStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sideBar.width;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      setSideBarWidth(startWidth + dx);
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, [sideBar.width]);

  const handleResizeDoubleClick = () => {
    setSideBarCollapsed(!collapsed);
    if (!collapsed) setSideBarWidth(MIN_RAIL_PX);
  };

  const openNewMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (newMenu) {
      setNewMenu(null);
      return;
    }
    setSettingsMenu(null);
    const rect = event.currentTarget.getBoundingClientRect();
    setNewMenu({
      anchor: { x: rect.right + 8, y: rect.top },
      viewportBounds: { width: window.innerWidth, height: window.innerHeight },
    });
  };

  const openSettingsMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (settingsMenu) {
      setSettingsMenu(null);
      return;
    }
    setNewMenu(null);
    const rect = event.currentTarget.getBoundingClientRect();
    setSettingsMenu({
      anchor: { x: rect.right + 8, y: rect.top },
      viewportBounds: { width: window.innerWidth, height: window.innerHeight },
    });
  };

  const displayWidth = collapsed ? MIN_RAIL_PX : width;

  if (entries.length === 0 && tier === "rail") {
    return (
      <aside
        className="operations-side-bar"
        data-tier={tier}
        data-canvas-blocker
        style={{ "--side-bar-width": `${displayWidth}px` } as CSSProperties}
      >
        <header className="operations-side-bar-header">
          <button
            type="button"
            className="side-bar-new-btn"
            onClick={openNewMenu}
            aria-label="New Operation"
            title="New Operation"
          >
            <NewIcon />
          </button>
        </header>
        <div className="operations-side-bar-resize-handle" onPointerDown={handleResizeDragStart} onDoubleClick={handleResizeDoubleClick} aria-hidden="true" />
        {newMenu ? createPortal(
          <CanvasContextMenu
            key={`${newMenu.anchor.x}:${newMenu.anchor.y}`}
            anchor={newMenu.anchor}
            viewportBounds={newMenu.viewportBounds}
            placement="cursor"
            mode="launch"
            catalog={catalog}
            canLaunch={canLaunch}
            renderKindIcon={renderKindIcon}
            onLaunchKind={(pluginId, kind) => { setNewMenu(null); onLaunchKind(pluginId, kind); }}
            onResetView={onResetView}
            onClose={() => setNewMenu(null)}
          />,
          document.body,
        ) : null}
      </aside>
    );
  }

  return (
    <aside
      className="operations-side-bar"
      data-tier={tier}
      data-canvas-blocker
      style={{ "--side-bar-width": `${displayWidth}px` } as CSSProperties}
    >
      <header className="operations-side-bar-header">
        <button
          type="button"
          className="side-bar-new-btn"
          onClick={openNewMenu}
          aria-label="New Operation"
          aria-expanded={newMenu !== null}
          title="New Operation"
        >
          <NewIcon />
          {tier !== "rail" ? <span>Operation</span> : null}
        </button>
        {tier !== "rail" ? (
          <button
            type="button"
            className="side-bar-settings-btn"
            onClick={openSettingsMenu}
            aria-expanded={settingsMenu !== null}
            aria-label="Map and display controls"
            title="Map and display controls"
          >
            <SettingsIcon />
          </button>
        ) : null}
      </header>

      <ol className="operations-side-bar-chips" ref={chipsRef} aria-label="Operations">
        {entries.map((entry, index) => {
          const accentKey = canvas.operationAccent[entry.operation.id] ?? operationAccentFromNode(entry.operation);
          const accentValue = accentKey ? resolveAccentColor(accentKey) : null;
          return (
            <OperationsSideBarChip
              key={entry.operation.id}
              entry={entry}
              index={index}
              isCloseArmed={armedCloseId === entry.operation.id}
              accentValue={accentValue}
              dragging={drag?.sourceId === entry.operation.id && drag.dragging}
              dragOffsetY={drag?.sourceId === entry.operation.id && drag.dragging ? drag.currentY - drag.startY : 0}
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
      </ol>

      <div
        className="operations-side-bar-resize-handle"
        onPointerDown={handleResizeDragStart}
        onDoubleClick={handleResizeDoubleClick}
        aria-hidden="true"
      />

      {newMenu ? createPortal(
        <CanvasContextMenu
          key={`${newMenu.anchor.x}:${newMenu.anchor.y}`}
          anchor={newMenu.anchor}
          viewportBounds={newMenu.viewportBounds}
          placement="cursor"
          mode="launch"
          catalog={catalog}
          canLaunch={canLaunch}
          renderKindIcon={renderKindIcon}
          onLaunchKind={(pluginId, kind) => { setNewMenu(null); onLaunchKind(pluginId, kind); }}
          onResetView={onResetView}
          onClose={() => setNewMenu(null)}
        />,
        document.body,
      ) : null}

      {settingsMenu ? createPortal(
        <CanvasContextMenu
          key={`settings:${settingsMenu.anchor.x}:${settingsMenu.anchor.y}`}
          anchor={settingsMenu.anchor}
          viewportBounds={settingsMenu.viewportBounds}
          placement="cursor"
          mode="controls"
          catalog={catalog}
          canLaunch={canLaunch}
          mapFullscreen={mapFullscreen}
          radarEnabled={radarEnabled}
          perimeterEnabled={perimeterEnabled}
          renderKindIcon={renderKindIcon}
          onLaunchKind={onLaunchKind}
          onResetView={() => { setSettingsMenu(null); onResetView(); }}
          onMaximizeMap={onMaximizeMap}
          onToggleRadar={onToggleRadar}
          onTogglePerimeter={onTogglePerimeter}
          onClose={() => setSettingsMenu(null)}
        />,
        document.body,
      ) : null}

      {accentPopover && popoverOperation ? (
        <AccentPopover
          anchor={accentPopover.anchor}
          accentKey={canvas.operationAccent[popoverOperation.id] ?? operationAccentFromNode(popoverOperation)}
          onSelect={(accentKey) => onSetAccent(popoverOperation.id, accentKey)}
          onClose={() => setAccentPopover(null)}
        />
      ) : null}

      <span className="sr-only" aria-live="polite">{statusMessage}</span>
    </aside>
  );
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

function reorderIds(orderedIds: readonly string[], sourceId: string, dropIndex: number): string[] {
  const sourceIndex = orderedIds.indexOf(sourceId);
  if (sourceIndex === -1) return [...orderedIds];
  const next = orderedIds.filter((id) => id !== sourceId);
  const insertAt = dropIndex > sourceIndex ? dropIndex - 1 : dropIndex;
  const bounded = Math.max(0, Math.min(insertAt, next.length));
  next.splice(bounded, 0, sourceId);
  return next;
}

function autoScrollSideBar(clientY: number, chipsElement: HTMLOListElement | null): void {
  if (!chipsElement) return;
  const rect = chipsElement.getBoundingClientRect();
  if (clientY < rect.top + AUTO_SCROLL_EDGE_PX) {
    chipsElement.scrollTop -= AUTO_SCROLL_STEP_PX;
  } else if (clientY > rect.bottom - AUTO_SCROLL_EDGE_PX) {
    chipsElement.scrollTop += AUTO_SCROLL_STEP_PX;
  }
}

function NewIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M12 2.4v3.4M12 18.2v3.4M2.4 12h3.4M18.2 12h3.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M12 9.2v5.6M9.2 12h5.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M8 1.4v1.4M8 13.2v1.4M1.4 8h1.4M13.2 8h1.4M3.3 3.3l1 1M11.7 11.7l1 1M11.7 3.3l-1 1M3.3 11.7l-1 1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}
