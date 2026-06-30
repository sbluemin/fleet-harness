import type { CSSProperties, MouseEvent } from "react";

import type { OperationGroup } from "../types.js";
import { resolveAccentColor } from "../canvas/operation-accent.js";

interface GroupHeaderProps {
  readonly group: OperationGroup;
  readonly count: number;
  readonly collapsed: boolean;
  readonly tier: "rail" | "list" | "detail";
  readonly onToggle: (groupId: string) => void;
  readonly onContextMenu: (groupId: string, anchor: DOMRect) => void;
}

export function OperationsSideBarGroupHeader({
  group,
  count,
  collapsed,
  tier,
  onToggle,
  onContextMenu,
}: GroupHeaderProps) {
  const grpColor = resolveAccentColor(group.color);
  const headerStyle = grpColor ? ({ "--grp-color": grpColor } as CSSProperties) : undefined;

  const handleContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    onContextMenu(group.id, event.currentTarget.getBoundingClientRect());
  };

  if (tier === "rail") {
    return (
      <div
        className="side-bar-group-header side-bar-group-header--rail"
        data-tier="rail"
        style={headerStyle}
        onClick={() => onToggle(group.id)}
        onContextMenu={handleContextMenu}
        role="button"
        tabIndex={0}
        aria-label={`Group ${group.name}`}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(group.id); } }}
      >
        <span className="side-bar-group-header__dot" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div
      className="side-bar-group-header"
      style={headerStyle}
      onContextMenu={handleContextMenu}
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
