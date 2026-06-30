import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type SyntheticEvent } from "react";

import { useInlineRename } from "../use-inline-rename.js";

import type { OperationNode } from "../types.js";

export interface SideBarEntry {
  readonly operation: OperationNode;
  readonly active: boolean;
  readonly minimized: boolean;
  readonly notificationCount: number;
  readonly icon: ReactNode;
}

interface SideBarChipProps {
  readonly entry: SideBarEntry;
  readonly index: number;
  readonly isCloseArmed: boolean;
  readonly accentValue: string | null;
  readonly dragging: boolean;
  readonly dragOffsetY: number;
  readonly dropTarget: boolean;
  readonly onArmClose: (operationId: string) => void;
  readonly onDisarmClose: () => void;
  readonly onClose: (operationId: string) => void;
  readonly onFocus: (operationId: string) => void;
  readonly onKeyboardMove: (operationId: string, direction: -1 | 1) => void;
  readonly onPointerDragStart: (event: ReactPointerEvent<HTMLLIElement>, operationId: string) => void;
  readonly onPointerDragMove: (event: ReactPointerEvent<HTMLLIElement>) => void;
  readonly onPointerDragEnd: (event: ReactPointerEvent<HTMLLIElement>) => void;
  readonly onPointerDragCancel: (event: ReactPointerEvent<HTMLLIElement>) => void;
  readonly grpColor?: string | null;
  readonly onOpenAccent: (operationId: string, anchor: DOMRect) => void;
  readonly onRename: (operationId: string, title: string) => void;
}

export function OperationsSideBarChip({
  entry,
  index,
  isCloseArmed,
  accentValue,
  dragging,
  dragOffsetY,
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
  grpColor,
  onOpenAccent,
  onRename,
}: SideBarChipProps) {
  const suppressClickRef = useRef(false);
  const { operation, active, minimized, notificationCount } = entry;
  const title = displayTitle(operation);
  const rename = useInlineRename({ currentTitle: title, onCommit: (next) => onRename(operation.id, next), onBegin: onDisarmClose });
  const chipClassName = [
    "side-bar-chip",
    active ? "side-bar-chip--active" : "",
    minimized ? "side-bar-chip--minimized" : "",
    dragging ? "side-bar-chip--dragging" : "",
    dropTarget ? "side-bar-chip--drop-target" : "",
  ].filter(Boolean).join(" ");
  const closeClassName = ["side-bar-chip-close", isCloseArmed ? "is-armed" : ""].filter(Boolean).join(" ");
  const chipStyle = {
    "--i": index,
    ...(accentValue ? { "--chip-accent": accentValue } : {}),
    ...(grpColor ? { "--grp-color": grpColor } : {}),
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

  return (
    <li
      data-side-bar-chip-id={operation.id}
      className={chipClassName}
      role="button"
      tabIndex={0}
      aria-label={active ? `${title} (focused)` : `Focus operation ${title}`}
      aria-current={active ? "true" : undefined}
      title={active ? "Focused · double-click to rename · right-click to set accent" : "Click to focus · double-click to rename · right-click to set accent"}
      style={chipStyle}
      onClick={focus}
      onContextMenu={openAccent}
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
        // 재배치: Alt+Shift+↑/↓ — shift 없는 Alt+↑/↓는 operations의 Operation 순환이 가져간다.
        if (event.altKey && event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
          event.preventDefault();
          onKeyboardMove(operation.id, event.key === "ArrowUp" ? -1 : 1);
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
      {grpColor ? <div className="side-bar-chip__rail" aria-hidden="true" /> : null}
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
        <span className="side-bar-chip-name" onDoubleClick={rename.begin}>{title}</span>
      )}
      {notificationCount > 0 ? (
        <span className="side-bar-chip-count">{notificationCount}</span>
      ) : null}
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
    </li>
  );
}

function displayTitle(operation: OperationNode): string {
  return operation.renamedTitle ?? operation.title;
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

function DefaultOpIcon() {
  return (
    <svg viewBox="0 0 14 14" aria-hidden="true">
      <rect x="2" y="2" width="10" height="10" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
