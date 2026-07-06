import { useRef, type CSSProperties, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";

import type { OperationGroup } from "../types.js";
import { resolveAccentColor } from "../canvas/operation-accent.js";

interface GroupHeaderProps {
  readonly group: OperationGroup;
  readonly count: number;
  readonly collapsed: boolean;
  readonly tier: "rail" | "list" | "detail";
  readonly dragging: boolean;
  readonly dropTarget: boolean;
  readonly dragOffsetY: number;
  readonly onToggle: (groupId: string) => void;
  readonly onContextMenu: (groupId: string, anchor: DOMRect) => void;
  readonly onPointerDragStart: (event: ReactPointerEvent<HTMLDivElement>, groupId: string) => void;
}

export function OperationsSideBarGroupHeader({
  group,
  count,
  collapsed,
  tier,
  dragging,
  dropTarget,
  dragOffsetY,
  onToggle,
  onContextMenu,
  onPointerDragStart,
}: GroupHeaderProps) {
  const suppressClickRef = useRef(false);
  const grpColor = resolveAccentColor(group.color);
  const headerClassName = [
    "side-bar-group-header",
    tier === "rail" ? "side-bar-group-header--rail" : "",
    dragging ? "side-bar-group-header--dragging" : "",
    dropTarget ? "side-bar-group-header--drop-target" : "",
  ].filter(Boolean).join(" ");
  const headerStyle = {
    ...(grpColor ? { "--grp-color": grpColor } : {}),
    ...(dragging ? { "--drag-dy": `${Math.round(dragOffsetY)}px` } : {}),
  } as CSSProperties;

  const handleContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    onContextMenu(group.id, event.currentTarget.getBoundingClientRect());
  };
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest("button")) return;
    onPointerDragStart(event, group.id);
  };
  const handlePointerUp = () => {
    if (dragging) suppressClickRef.current = true;
  };
  const toggle = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onToggle(group.id);
  };

  if (tier === "rail") {
    return (
      <div
        className={headerClassName}
        data-tier="rail"
        style={headerStyle}
        onClick={toggle}
        onContextMenu={handleContextMenu}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        role="button"
        tabIndex={0}
        aria-label={`Group ${group.name}`}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }}
      >
        <span className="side-bar-group-header__dot" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div
      className={headerClassName}
      style={headerStyle}
      onContextMenu={handleContextMenu}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      role="group"
      aria-label={group.name}
    >
      <button
        type="button"
        className="side-bar-group-header__toggle"
        onClick={() => onToggle(group.id)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? `Expand group ${group.name}` : `Collapse group ${group.name}`}
        title={collapsed ? "Expand" : "Collapse"}
      >
        <CollapseArrow collapsed={collapsed} />
      </button>
      <span className="side-bar-group-header__name">{group.name}</span>
      <span className="side-bar-group-header__count" aria-label={`${count} operations`}>{count}</span>
    </div>
  );
}

function CollapseArrow({ collapsed }: { readonly collapsed: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden="true"
      className={`side-bar-group-header__arrow${collapsed ? " is-collapsed" : ""}`}
    >
      <path d="M3 5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
