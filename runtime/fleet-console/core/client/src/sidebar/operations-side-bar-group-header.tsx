import { useRef, useSyncExternalStore, type CSSProperties, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { consoleUseWrapClassName, gestureCallerLabel, getGroupCreator, getGroupWrap, subscribeConsoleUseGestures } from "../console-use-gestures.js";

import { useT } from "../i18n/index.js";
import type { OperationGroup } from "../types.js";
import { resolveAccentColor } from "../canvas/operation-accent.js";

interface GroupHeaderProps {
  readonly group: OperationGroup;
  readonly count: number;
  readonly collapsed: boolean;
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
  dragging,
  dropTarget,
  dragOffsetY,
  onToggle,
  onContextMenu,
  onPointerDragStart,
}: GroupHeaderProps) {
  const t = useT();
  const suppressClickRef = useRef(false);
  const grpColor = resolveAccentColor(group.color);
  // Console Use — 에이전트가 이 그룹을 만들거나 고치면 헤더 전체가 감싸인다. 만든 이는 툴팁에만 남는다(사실이지 사건이 아니다).
  const wrap = useSyncExternalStore(subscribeConsoleUseGestures, () => getGroupWrap(group.id), () => null);
  const creator = useSyncExternalStore(subscribeConsoleUseGestures, () => getGroupCreator(group.id), () => null);
  const headerClassName = [
    "side-bar-group-header",
    consoleUseWrapClassName(wrap),
    collapsed ? "side-bar-group-header--collapsed" : "",
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

  return (
    <div
      className={headerClassName}
      style={headerStyle}
      onContextMenu={handleContextMenu}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      role="group"
      aria-label={group.name}
      title={wrap ? `${gestureCallerLabel(wrap.gesture.caller)}: ${wrap.gesture.summary}` : creator ? t("sidebar.group.createdBy", { caller: gestureCallerLabel(creator.caller) }) : undefined}
    >
      <button
        type="button"
        className="side-bar-group-header__toggle"
        onClick={() => onToggle(group.id)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? t("sidebar.group.expand", { name: group.name }) : t("sidebar.group.collapse", { name: group.name })}
        title={collapsed ? t("sidebar.status.expand") : t("sidebar.status.collapse")}
      >
        <CollapseArrow collapsed={collapsed} />
      </button>
      <span className="side-bar-group-header__name">{group.name}</span>
      <span className="side-bar-group-header__count" aria-label={t("sidebar.group.operationsCount", { count })}>{count}</span>
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

/** 에이전트가 만든 그룹의 저자 — hover 로 읽는 작은 표식. 사람이 만든 그룹에는 없다. */
