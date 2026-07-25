import { useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type SyntheticEvent } from "react";

import type { OperationActivity } from "@fleet-console/sdk/plugin";

import { operationActivityLabel, operationActivityVisual } from "../operation-activity.js";
import { useInlineRename } from "../use-inline-rename.js";
import type { OperationNode } from "../types.js";
import { subscribeSideBarOperationAction } from "./operation-action-request.js";

export interface SideBarEntry {
  readonly operation: OperationNode;
  readonly active: boolean;
  readonly minimized: boolean;
  readonly notificationCount: number;
  readonly status?: OperationActivity;
  readonly icon: ReactNode;
}

interface SideBarChipProps {
  readonly entry: SideBarEntry;
  readonly index: number;
  readonly isCloseArmed: boolean;
  readonly accentValue: string | null;
  readonly groupMark?: { readonly name: string; readonly color: string } | null;
  readonly statusAxis?: boolean;
  readonly statusLanded?: boolean;
  readonly reorderEnabled?: boolean;
  readonly dragging: boolean;
  readonly dragOffsetY: number;
  readonly dropTarget: boolean;
  /** peek(비활성 Theater) 미리보기 칩 — focus만 살리고 close/rename/accent/재배치 어포던스를 렌더하지 않는다. */
  readonly preview?: boolean;
  readonly onArmClose: (operationId: string) => void;
  readonly onDisarmClose: () => void;
  readonly onClose: (operationId: string) => void;
  readonly onMinimize: (operationId: string) => void;
  readonly onFocus: (operationId: string) => void;
  readonly onKeyboardMove: (operationId: string, direction: -1 | 1) => void;
  readonly onPointerDragStart: (event: ReactPointerEvent<HTMLLIElement>, operationId: string) => void;
  readonly onOpenAccent: (operationId: string, anchor: DOMRect, returnFocus?: HTMLElement | null) => void;
  readonly onRename: (operationId: string, title: string) => void;
}

export function OperationsSideBarChip({
  entry,
  index,
  isCloseArmed,
  accentValue,
  groupMark = null,
  statusAxis = false,
  statusLanded = false,
  reorderEnabled = true,
  dragging,
  dragOffsetY,
  dropTarget,
  preview = false,
  onArmClose,
  onDisarmClose,
  onClose,
  onMinimize,
  onFocus,
  onKeyboardMove,
  onPointerDragStart,
  onOpenAccent,
  onRename,
}: SideBarChipProps) {
  const chipRef = useRef<HTMLLIElement | null>(null);
  const suppressClickRef = useRef(false);
  const { operation, active, minimized, notificationCount, status } = entry;
  const title = displayTitle(operation);
  const groupContext = statusAxis && groupMark ? ` in group ${groupMark.name}` : "";
  const chipAriaLabel = active
    ? `${title}${groupContext} (focused)`
    : `Focus operation ${title}${groupContext}`;
  const rename = useInlineRename({ currentTitle: title, onCommit: (next) => onRename(operation.id, next), onBegin: onDisarmClose });
  const chipClassName = [
    "side-bar-chip",
    active ? "side-bar-chip--active" : "",
    minimized ? "side-bar-chip--minimized" : "",
    statusLanded ? "side-bar-chip--status-landed" : "",
    dragging ? "side-bar-chip--dragging" : "",
    dropTarget ? "side-bar-chip--drop-target" : "",
  ].filter(Boolean).join(" ");
  const closeClassName = ["side-bar-chip-close", isCloseArmed ? "is-armed" : ""].filter(Boolean).join(" ");
  const chipStyle = {
    "--i": index,
    ...(accentValue ? { "--user-accent": accentValue } : {}),
    ...(dragging ? { "--drag-dy": `${Math.round(dragOffsetY)}px` } : {}),
  } as CSSProperties;

  const focus = () => {
    onDisarmClose();
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onFocus(operation.id);
  };
  const stopClosePointer = (event: SyntheticEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };
  const close = (event: SyntheticEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!isCloseArmed) {
      onArmClose(operation.id);
      return;
    }
    onDisarmClose();
    onClose(operation.id);
  };
  // accent 진입 = 우클릭(컨텍스트 메뉴) / 키보드 Menu 키. 칩 본클릭은 focus 전용이므로
  // rail tier에서 중앙 아이콘을 눌러도 focus가 동작한다.
  const openAccent = (event: SyntheticEvent<HTMLLIElement>) => {
    event.preventDefault();
    onDisarmClose();
    onOpenAccent(operation.id, event.currentTarget.getBoundingClientRect());
  };

  useEffect(() => subscribeSideBarOperationAction((request) => {
    if (request.operationId !== operation.id || preview) return false;
    const chip = chipRef.current;
    if (!chip) return false;
    if (chip.closest("[inert]")) return false;
    if (request.action === "rename") {
      rename.begin();
      return true;
    }
    if (request.action === "assign-group" || request.action === "set-accent") {
      onDisarmClose();
      onOpenAccent(operation.id, chip.getBoundingClientRect(), chip);
      return true;
    }
    onDisarmClose();
    onMinimize(operation.id);
    chip.focus();
    return true;
  }), [onDisarmClose, onMinimize, onOpenAccent, operation.id, preview, rename]);

  return (
    <li
      ref={chipRef}
      data-side-bar-chip-id={operation.id}
      data-reorder-enabled={reorderEnabled ? "true" : "false"}
      className={chipClassName}
      role="button"
      tabIndex={0}
      aria-haspopup={preview ? undefined : "menu"}
      aria-label={chipAriaLabel}
      aria-current={active ? "true" : undefined}
      title={preview ? "Click to open in its Theater" : active ? "Focused · double-click to rename · right-click to set accent" : "Click to focus · double-click to rename · right-click to set accent"}
      style={chipStyle}
      onClick={focus}
      onContextMenu={preview ? undefined : openAccent}
      onFocus={() => {
        if (!isCloseArmed) onDisarmClose();
      }}
      onPointerDown={reorderEnabled ? (event) => onPointerDragStart(event, operation.id) : undefined}
      onPointerUp={() => {
        if (dragging) suppressClickRef.current = true;
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        // 재배치: Alt+Shift+↑/↓ — shift 없는 Alt+↑/↓는 operations의 Operation 순환이 가져간다.
        if (!preview && reorderEnabled && event.altKey && event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
          event.preventDefault();
          onKeyboardMove(operation.id, event.key === "ArrowUp" ? -1 : 1);
          return;
        }
        if (!preview && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
          event.preventDefault();
          onDisarmClose();
          onOpenAccent(operation.id, event.currentTarget.getBoundingClientRect(), event.currentTarget);
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          focus();
        }
      }}
    >
      <span className="side-bar-chip-beacon-button" aria-hidden="true">
        <span className="side-bar-chip-op-icon">
          {entry.icon ?? <DefaultOpIcon />}
        </span>
      </span>
      {rename.renaming ? (
        <input
          className="side-bar-chip-rename-input"
          ref={rename.inputRef}
          value={rename.draftTitle}
          aria-label={`Rename operation ${title}`}
          onChange={(e) => rename.setDraftTitle(e.target.value)}
          onKeyDown={rename.handleKeyDown}
          onBlur={rename.handleBlur}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="side-bar-chip-name" onDoubleClick={preview ? undefined : rename.begin}>{title}</span>
      )}
      {notificationCount > 0 ? (
        <span className="side-bar-chip-count">{notificationCount}</span>
      ) : null}
      {groupMark && statusAxis && !preview ? (
        <span
          className="side-bar-chip-group-pill"
          title={groupMark.name}
          aria-hidden="true"
          style={{ "--group-mark": groupMark.color } as CSSProperties}
        >
          {groupMark.name}
        </span>
      ) : groupMark && !statusAxis ? (
        <span
          className="side-bar-chip-group-mark"
          title={groupMark.name}
          aria-label={`Group ${groupMark.name}`}
          style={{ "--group-mark": groupMark.color } as CSSProperties}
        />
      ) : null}
      {!statusAxis ? (
        <span
          className={`side-bar-chip-status ${chipStatusClass(status)}`}
          role="img"
          aria-label={chipStatusLabel(status)}
          title={chipStatusLabel(status)}
        />
      ) : null}
      {!preview && !minimized ? (
        <button
          type="button"
          className="side-bar-chip-minimize"
          onPointerDown={stopClosePointer}
          onClick={(event) => {
            event.stopPropagation();
            // 다른 칩 액션(focus·rename·accent)과 동일하게, 최소화 전에 armed close를 먼저 해제한다 —
            // 그러지 않으면 최소화 후에도 "Close?" armed 상태가 타임아웃까지 남아 단발 클릭 close 위험이 생긴다.
            onDisarmClose();
            onMinimize(operation.id);
          }}
          aria-label={`Minimize operation ${title}`}
          title="Minimize operation"
        >
          <SideBarMinimizeIcon />
        </button>
      ) : null}
      {preview ? null : (
        <button
          type="button"
          className={closeClassName}
          onPointerDown={stopClosePointer}
          onClick={close}
          aria-label={isCloseArmed ? `Confirm close operation ${title}` : `Close operation ${title}`}
          title={isCloseArmed ? "Confirm close" : "Close operation"}
        >
          {isCloseArmed ? "Close?" : <SideBarCloseIcon />}
        </button>
      )}
    </li>
  );
}

function displayTitle(operation: OperationNode): string {
  return operation.title;
}

function chipStatusClass(status: OperationActivity | undefined): string {
  const visual = operationActivityVisual(status);
  if (visual === "running") return "tenant-beacon is-turn-running";
  if (visual === "awaiting") return "tenant-beacon is-awaiting";
  if (visual === "dormant") return "tenant-beacon is-dormant";
  return "tenant-beacon is-idle";
}

function chipStatusLabel(status: OperationActivity | undefined): string {
  return operationActivityLabel(status);
}

function SideBarCloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M4.6 4.6 11.4 11.4M11.4 4.6 4.6 11.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SideBarMinimizeIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 11.5h9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function DefaultOpIcon() {
  return (
    <svg viewBox="0 0 14 14" aria-hidden="true">
      <rect x="2" y="2" width="10" height="10" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
