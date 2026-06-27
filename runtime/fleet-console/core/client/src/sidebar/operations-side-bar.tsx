import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import type { OperationCatalogPlugin, OperationLaunchKind } from "@fleet-console/sdk/operations";
import type { OperationActivity } from "@fleet-console/sdk/plugin";

import type { OperationNode, OperationNotification } from "../types.js";
import { AccentPopover } from "../canvas/accent-popover.js";
import { CanvasContextMenu } from "../canvas/canvas-context-menu.js";
import { operationAccentFromNode, resolveAccentColor } from "../canvas/operation-accent.js";
import { setOperationOrder, useCanvasState } from "../canvas/canvas-store.js";
import { dropIndexFromPoint } from "./operations-side-bar-hit-test.js";
import { OperationsSideBarChip, type SideBarEntry, type SideBarUnderway } from "./operations-side-bar-chip.js";
import { MIN_RAIL_PX, setSideBarCollapsed, setSideBarWidth, tierFromWidth, useSideBarState } from "./operations-side-bar-store.js";

interface OperationsSideBarProps {
  readonly operations: readonly OperationNode[];
  readonly minimized: readonly string[];
  readonly activeOperationId: string | null;
  readonly operationStatus: Readonly<Record<string, OperationActivity>>;
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
const MENU_REQUIRED_WIDTH = 300;

export function OperationsSideBar({
  operations,
  minimized,
  activeOperationId,
  operationStatus,
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
  const [statusMessage, setStatusMessage] = useState("");

  const minimizedSet = new Set(minimized);
  const entries: SideBarEntry[] = sortOperations(operations, canvas.operationOrder).map((operation) => {
    const underway = resolveUnderway(operation.id, operationStatus, operationNotifications);
    const kind = catalog.find((p) => p.id === operation.pluginId)?.kinds.find((k) => k.type === operation.type) ?? null;
    const icon = kind ? renderKindIcon(operation.pluginId, kind) : null;
    return {
      operation,
      active: activeOperationId === operation.id,
      minimized: minimizedSet.has(operation.id),
      beaconClassName: beaconClassNameFor(underway, operationStatus[operation.id]),
      notificationCount: operationNotifications[operation.id]?.count ?? 0,
      underway,
      showRing: underway !== null && minimizedSet.has(operation.id),
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
    const rect = event.currentTarget.getBoundingClientRect();
    setNewMenu({
      anchor: { x: rect.left, y: rect.bottom + 4 },
      viewportBounds: { width: window.innerWidth, height: window.innerHeight },
    });
  };

  // newMenu 열림 시 사이드바 폭이 MENU_REQUIRED_WIDTH 미만이면 transient 확장해 메뉴가 잘리지 않게 한다.
  // localStorage 영속 폭은 건드리지 않는다.
  const displayWidth = collapsed ? MIN_RAIL_PX : (newMenu !== null && width < MENU_REQUIRED_WIDTH ? MENU_REQUIRED_WIDTH : width);

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
        {newMenu ? (
          <CanvasContextMenu
            key={`${newMenu.anchor.x}:${newMenu.anchor.y}`}
            anchor={newMenu.anchor}
            viewportBounds={newMenu.viewportBounds}
            placement="cursor"
            catalog={catalog}
            canLaunch={canLaunch}
            mapFullscreen={mapFullscreen}
            radarEnabled={radarEnabled}
            perimeterEnabled={perimeterEnabled}
            renderKindIcon={renderKindIcon}
            onLaunchKind={(pluginId, kind) => { setNewMenu(null); onLaunchKind(pluginId, kind); }}
            onResetView={() => { setNewMenu(null); onResetView(); }}
            onMaximizeMap={onMaximizeMap}
            onToggleRadar={onToggleRadar}
            onTogglePerimeter={onTogglePerimeter}
            onClose={() => setNewMenu(null)}
          />
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
          {tier !== "rail" ? <span>New</span> : null}
        </button>
        {tier !== "rail" ? (
          <button
            type="button"
            className="side-bar-settings-btn"
            disabled
            aria-disabled="true"
            aria-label="Sidebar settings"
            title="Settings (coming soon)"
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

      <footer className="operations-side-bar-footer">
        <button
          type="button"
          className={`side-bar-footer-btn${mapFullscreen ? " is-active" : ""}`}
          onClick={onMaximizeMap}
          aria-label="Map fullscreen"
          title="Map fullscreen"
        >
          <MapMaximizeIcon />
        </button>
        <button
          type="button"
          className={`side-bar-footer-btn${radarEnabled ? " is-active" : ""}`}
          onClick={onToggleRadar}
          aria-label="Radar sweep"
          title="Radar sweep"
        >
          <RadarIcon />
        </button>
        <button
          type="button"
          className={`side-bar-footer-btn${perimeterEnabled ? " is-active" : ""}`}
          onClick={onTogglePerimeter}
          aria-label="Panel pulse"
          title="Panel pulse"
        >
          <PanelPulseIcon />
        </button>
      </footer>

      <div
        className="operations-side-bar-resize-handle"
        onPointerDown={handleResizeDragStart}
        onDoubleClick={handleResizeDoubleClick}
        aria-hidden="true"
      />

      {newMenu ? (
        <CanvasContextMenu
          key={`${newMenu.anchor.x}:${newMenu.anchor.y}`}
          anchor={newMenu.anchor}
          viewportBounds={newMenu.viewportBounds}
          placement="cursor"
          catalog={catalog}
          canLaunch={canLaunch}
          mapFullscreen={mapFullscreen}
          radarEnabled={radarEnabled}
          perimeterEnabled={perimeterEnabled}
          renderKindIcon={renderKindIcon}
          onLaunchKind={(pluginId, kind) => { setNewMenu(null); onLaunchKind(pluginId, kind); }}
          onResetView={() => { setNewMenu(null); onResetView(); }}
          onMaximizeMap={onMaximizeMap}
          onToggleRadar={onToggleRadar}
          onTogglePerimeter={onTogglePerimeter}
          onClose={() => setNewMenu(null)}
        />
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

function resolveUnderway(
  operationId: string,
  operationStatus: Readonly<Record<string, OperationActivity>>,
  operationNotifications: Readonly<Record<string, OperationNotification>>,
): SideBarUnderway {
  const status = operationStatus[operationId];
  if (operationNotifications[operationId]?.kind === "input-waiting" || status === "awaiting") return "awaiting";
  if (status === "running") return "turn";
  if (status === "live") return "live";
  return null;
}

function beaconClassNameFor(underway: SideBarUnderway, status: OperationActivity | undefined): string {
  if (underway === "turn") return "tenant-beacon is-turn-running";
  if (underway === "awaiting") return "tenant-beacon is-turn-ended";
  if (status === "dormant") return "tenant-beacon is-dormant";
  return "tenant-beacon is-live";
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

function MapMaximizeIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M9.5 3.5h3v3M12.5 3.5 9 7M6.5 12.5h-3v-3M3.5 12.5 7 9" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RadarIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 8 12 5.6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" />
    </svg>
  );
}

function PanelPulseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3" y="3.2" width="10" height="9.6" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M10.9 3.2H13v2.1M5.1 12.8H3v-2.1" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.6 5.1c.5 1.4.4 2.9-.3 4.2M3.4 10.9c-.5-1.4-.4-2.9.3-4.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="11.7" cy="4.2" r="0.9" fill="currentColor" />
    </svg>
  );
}
