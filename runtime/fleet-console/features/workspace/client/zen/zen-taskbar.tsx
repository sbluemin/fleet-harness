import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { OperationRuntimeState } from "@fleet-console/sdk/plugin";

import { useT } from "../../../../core/client/src/i18n/index.js";
import type { OperationGroup, OperationNode, OperationNotification, TheaterInfo } from "../../../../core/client/src/integration/types.js";
import { operationOrderFromNodes, setOperationOrder, sortOperationsByOrder } from "../../../../core/client/src/integration/store.js";
import { operationAccentFromNode, resolveAccentColor } from "../canvas/operation-accent.js";
import { useCanvasState } from "../canvas/canvas-store.js";
import { insertIntoSegment, reorderWithinSegment } from "../sidebar/operations-side-bar-hit-test.js";
import { SideBarStatusViewToggle } from "../sidebar/side-bar-collapse-control.js";
import { OperationNameMark } from "../../../execution/client/components/operation-name-mark.js";
import { resolveOperationActivity, resolveOperationDisplayActivity, resolveOperationMarkVisual } from "../../../execution/client/operation-activity.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "../../../execution/client/operation-marks.js";
import { groupOperations, groupOperationsByStatus, theaterInitials } from "../sidebar/operations-side-bar.js";
import type { SideBarEntry } from "../sidebar/operations-side-bar-chip.js";
import { getStatusTransitionTick, useSideBarStatusAxis } from "../sidebar/operations-side-bar-store.js";
import { useContextMenuKeyboard } from "../sidebar/context-menu-keyboard.js";
import "./zen-taskbar.css";

/**
 * Zen 작업 표시줄 — Zen이 좌측 사이드바를 걷은 자리를 화면 아래 한 줄이 잇는다.
 *
 * 왼쪽은 지금 Theater의 Operation 목록이다. Theater는 이름을 눌러 위로 여는 메뉴에서 바꾸고,
 * 목록은 사이드바와 같은 상태별 보기 토글(같은 부품, Alt+S)을 따라 상태 또는 사용자 그룹으로 나뉜다.
 * 묶음 이름 앞의 점과 이름 잉크가 사이드바와 같은 상태·그룹 색을 말하고, Operation 이름은 제 강조색을 입는다.
 * 막대가 모자라면 모든 묶음을 「이름 + 개수」 칩으로 접고, 지금 보는 Operation 하나만 자기
 * 묶음 칩 옆에 이름째 남긴다 — Operation이 몇 개로 늘어도 막대 길이가 묶음 수에만 비례한다.
 *
 * 그룹별 보기에서는 Operation을 좌우로 끌어(⌥⇧←/→) 순서를 바꾼다. 순서는 사이드바와 같은 서버 값
 * 하나라 일반 모드에서도 그대로 보이고, 다른 묶음에 놓으면 사이드바처럼 그 그룹으로 옮겨 간다.
 * 접힌 묶음 메뉴 안에서는 위아래로 끈다. 상태별 보기의 칸 순서는 상태 전이가 정하므로 끌지 않는다.
 *
 * 오른쪽 끝의 도구모음·Fleet 앰블럼은 트레이(core zen-bar)가 진다. 트레이가 막대 위 오른쪽에 겹쳐
 * 서므로 막대는 --zen-bar-width만큼 오른쪽을 비워 둔다.
 */

/** 막대 높이 — theme.css의 --zen-taskbar-height와 한 값. 아레나 하단 인셋의 원료다. */
export const ZEN_TASKBAR_HEIGHT = 36;

interface ZenTaskbarProps {
  readonly theaters: readonly TheaterInfo[];
  readonly activeTheaterId: string | null;
  readonly operations: readonly OperationNode[];
  readonly groups: readonly OperationGroup[];
  readonly minimized: readonly string[];
  readonly activeOperationId: string | null;
  readonly operationNotifications: Readonly<Record<string, OperationNotification>>;
  readonly operationRuntime: Readonly<Record<string, OperationRuntimeState>>;
  readonly onFocus: (operationId: string) => void;
  readonly onResume: (operationId: string) => void;
  readonly onSelectTheater: (theaterId: string) => void;
  /** 다른 그룹의 묶음에 끌어 놓으면 그 그룹으로 옮긴다 — 사이드바의 끌어 놓기와 같은 규칙. */
  readonly onSetGroupId: (operationId: string, groupId: string | null) => void;
}

interface TaskbarGroup {
  readonly key: string;
  readonly label: string;
  readonly entries: readonly SideBarEntry[];
  /** 묶음의 색 — 상태 칸은 상태 신호, 그룹은 그 그룹의 정체성 톤, 미분류는 무채. */
  readonly color: string;
  /** 그룹별 보기의 그룹 id(미분류는 null). 상태 칸이면 undefined — 끌어 놓을 수 없다. */
  readonly groupId?: string | null;
}

/** 끌기의 도착점 — 어느 묶음의 어느 Operation 앞(끝이면 null). */
interface DropTarget {
  readonly groupKey: string;
  readonly beforeId: string | null;
  /** 표시선의 화면 좌표 — 막대에서는 세로선, 메뉴에서는 가로선. */
  readonly line: { readonly left: number; readonly top: number; readonly length: number; readonly axis: "x" | "y" };
}

interface DragState {
  readonly id: string;
  readonly pointerId: number;
  readonly axis: "x" | "y";
  readonly start: number;
  readonly offset: number;
  readonly dragging: boolean;
  readonly target: DropTarget | null;
}

const DRAG_THRESHOLD_PX = 4;

// 상태 칸의 색은 사이드바 STATUS 칸 머리와 같은 상태 신호다(components.css --activity-color).
const STATUS_COLOR: Readonly<Record<string, string>> = {
  awaiting: "var(--aurora)",
  running: "var(--warn)",
  idle: "var(--positive)",
  ended: "var(--ink-fog)",
};

type OpenMenu =
  | { readonly kind: "theaters"; readonly anchor: DOMRect }
  | { readonly kind: "group"; readonly key: string; readonly anchor: DOMRect };

const MENU_SELECTOR = ".zen-taskbar-menu";
const MENU_GAP = 8;
const MENU_WIDTH = 272;

export function ZenTaskbar({
  theaters,
  activeTheaterId,
  operations,
  groups,
  minimized,
  activeOperationId,
  operationNotifications,
  operationRuntime,
  onFocus,
  onResume,
  onSelectTheater,
  onSetGroupId,
}: ZenTaskbarProps) {
  const t = useT();
  const statusAxis = useSideBarStatusAxis();
  const idleArrivalIds = useSyncExternalStore(subscribeIdleArrival, getIdleArrivalIds, getIdleArrivalIds);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [compact, setCompact] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const menuReturnFocusRef = useRef<HTMLElement | null>(null);
  const canvas = useCanvasState();
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);

  const theater = theaters.find((candidate) => candidate.id === activeTheaterId) ?? null;
  const theaterOperations = operations.filter((operation) => operation.theaterId === activeTheaterId);
  const order = operationOrderFromNodes(theaterOperations);
  const minimizedSet = new Set(minimized);
  const entries: SideBarEntry[] = sortOperationsByOrder(theaterOperations, order).map((operation) => {
    const activity = resolveOperationActivity(operation, operationRuntime);
    return {
      operation,
      active: activeOperationId === operation.id,
      minimized: minimizedSet.has(operation.id),
      notificationCount: operationNotifications[operation.id] ? 1 : 0,
      status: activity,
      mark: resolveOperationMarkVisual({ activity, operationId: operation.id, idleArrivalIds }),
    };
  });
  const taskbarGroups: TaskbarGroup[] = statusAxis
    ? groupOperationsByStatus(entries, getStatusTransitionTick, t)
      .filter((section) => section.entries.length > 0)
      // 사이드바의 종료 칸 이름은 다시 시작하는 법까지 말하는 긴 문장이다 — 한 줄 막대에는 상태 이름만 선다.
      .map((section) => ({
        key: `status:${section.status}`,
        label: section.status === "ended" ? t("zen.taskbar.ended") : section.label,
        entries: section.entries,
        color: STATUS_COLOR[section.status] ?? "var(--ink-fog)",
      }))
    : groupOperations(entries, groups.filter((group) => group.theaterId === activeTheaterId), order)
      .filter((section) => section.entries.length > 0)
      .map((section) => ({
        key: `group:${section.groupId ?? "none"}`,
        label: section.group?.name ?? t("sidebar.ungrouped.label"),
        entries: section.entries,
        color: (section.group ? resolveAccentColor(section.group.color) : null) ?? "var(--ink-fog)",
        groupId: section.groupId ?? null,
      }));
  // 재정렬 기준은 Theater 전체 순서다 — 보이는 목록으로 순서를 쓰면 빠진 Operation의 순서가 지워진다.
  const currentOrder = entries.map((entry) => entry.operation.id);
  const reorderEnabled = !statusAxis && activeTheaterId !== null;

  // 다른 Theater에 답을 기다리는 Operation이 있으면 글리프 모서리가 알린다 — 목록은 지금 Theater만
  // 보여 주므로, 그 밖의 대기는 이 점이 아니면 Zen 안에서 보이지 않는다.
  const awaitingCountOf = (theaterId: string) => operations.filter((operation) =>
    operation.theaterId === theaterId
    && resolveOperationDisplayActivity({ activity: resolveOperationActivity(operation, operationRuntime), operationId: operation.id, idleArrivalIds }) === "awaiting").length;
  const otherTheaterAwaiting = theaters.some((candidate) => candidate.id !== activeTheaterId && awaitingCountOf(candidate.id) > 0);

  // 넘침 판정은 언제나 「모두 펼친 모양」의 실측 폭으로 한다. 보이는 줄은 접힌 모양일 수 있으므로,
  // 그리지 않는 측정용 사본(aria-hidden · inert)을 같은 자리에 두고 그 폭을 목록 칸과 비교한다.
  useLayoutEffect(() => {
    const list = listRef.current;
    const measure = measureRef.current;
    if (list === null || measure === null) return;
    const update = () => setCompact(measure.scrollWidth > list.clientWidth + 1);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(list);
    observer.observe(measure);
    return () => observer.disconnect();
  });

  const closeMenu = useCallback(() => setMenu(null), []);
  useContextMenuKeyboard({ open: menu !== null, menuSelector: MENU_SELECTOR, returnFocusRef: menuReturnFocusRef, onEscape: closeMenu });
  useEffect(() => {
    if (menu === null) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && (target.closest(MENU_SELECTOR) || target.closest("[data-zen-taskbar-menu-anchor]"))) return;
      setMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [menu]);

  const toggleMenu = (next: OpenMenu, anchorElement: HTMLElement) => {
    menuReturnFocusRef.current = anchorElement;
    setMenu((current) => current !== null && current.kind === next.kind && (current.kind !== "group" || next.kind !== "group" || current.key === next.key) ? null : next);
  };

  const activate = (entry: SideBarEntry) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setMenu(null);
    if (entry.status === "ended") onResume(entry.operation.id);
    else onFocus(entry.operation.id);
  };

  // ── 끌어서 순서 바꾸기 ─────────────────────────────────────────────
  // 순서를 쓰는 규칙은 사이드바와 같은 순수 함수가 진다(같은 묶음이면 묶음 안 재배치, 다른 묶음이면
  // 그 묶음에 끼우고 그룹을 바꾼다). 이 막대가 새로 가진 것은 가로(메뉴에서는 세로) 위치 판정뿐이다.
  const commitMove = (sourceId: string, groupKey: string, beforeId: string | null) => {
    if (activeTheaterId === null) return;
    const source = entries.find((entry) => entry.operation.id === sourceId);
    const target = taskbarGroups.find((group) => group.key === groupKey);
    if (source === undefined || target === undefined || target.groupId === undefined) return;
    const segmentIds = target.entries.map((entry) => entry.operation.id);
    const index = beforeId === null ? segmentIds.length : Math.max(0, segmentIds.indexOf(beforeId));
    const sourceGroupId = source.operation.groupId ?? null;
    if (target.groupId !== sourceGroupId) {
      setOperationOrder(activeTheaterId, insertIntoSegment(currentOrder, sourceId, index, segmentIds));
      onSetGroupId(sourceId, target.groupId);
      return;
    }
    const next = reorderWithinSegment(currentOrder, sourceId, index, segmentIds);
    if (next.join("\0") !== currentOrder.join("\0")) setOperationOrder(activeTheaterId, next);
  };
  const commitMoveRef = useRef(commitMove);
  commitMoveRef.current = commitMove;

  const updateDrag = (next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>, entry: SideBarEntry, axis: "x" | "y") => {
    if (!reorderEnabled || event.button !== 0 || event.pointerType === "touch") return;
    suppressClickRef.current = false;
    updateDrag({ id: entry.operation.id, pointerId: event.pointerId, axis, start: axis === "x" ? event.clientX : event.clientY, offset: 0, dragging: false, target: null });
  };

  const dragPointerId = drag?.pointerId ?? null;
  useEffect(() => {
    if (dragPointerId === null) return;
    const onMove = (event: PointerEvent) => {
      const current = dragRef.current;
      if (current === null || event.pointerId !== current.pointerId) return;
      if (event.buttons === 0) {
        updateDrag(null);
        return;
      }
      const point = current.axis === "x" ? event.clientX : event.clientY;
      const offset = point - current.start;
      if (!current.dragging && Math.abs(offset) < DRAG_THRESHOLD_PX) return;
      event.preventDefault();
      const container = document.querySelector<HTMLElement>(current.axis === "x" ? ".zen-taskbar-list" : MENU_SELECTOR);
      updateDrag({ ...current, dragging: true, offset, target: container === null ? null : findDropTarget(container, current.axis, point, current.id) });
    };
    const onUp = (event: PointerEvent) => {
      const current = dragRef.current;
      if (current === null || event.pointerId !== current.pointerId) return;
      updateDrag(null);
      if (!current.dragging) return;
      // 끌기를 마친 뒤 따라오는 click은 Operation을 여는 누름이 아니다.
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
      if (current.target !== null) commitMoveRef.current(current.id, current.target.groupKey, current.target.beforeId);
    };
    const onCancel = (event: PointerEvent) => {
      if (event.pointerId === dragRef.current?.pointerId) updateDrag(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") updateDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [dragPointerId]);
  useEffect(() => {
    if (!reorderEnabled && dragRef.current !== null) updateDrag(null);
  }, [reorderEnabled]);

  // 키보드 — ⌥⇧←/→(메뉴에서는 ↑/↓)로 같은 묶음 안에서 한 칸씩 옮긴다.
  const keyboardMove = (event: ReactKeyboardEvent<HTMLButtonElement>, entry: SideBarEntry, axis: "x" | "y") => {
    if (!event.altKey || !event.shiftKey) return;
    const back = axis === "x" ? "ArrowLeft" : "ArrowUp";
    const forward = axis === "x" ? "ArrowRight" : "ArrowDown";
    if (event.key !== back && event.key !== forward) return;
    event.preventDefault();
    event.stopPropagation();
    if (!reorderEnabled) return;
    const group = taskbarGroups.find((candidate) => candidate.entries.some((item) => item.operation.id === entry.operation.id));
    if (group === undefined) return;
    const ids = group.entries.map((item) => item.operation.id);
    const index = ids.indexOf(entry.operation.id);
    if (event.key === back && index > 0) commitMove(entry.operation.id, group.key, ids[index - 1]!);
    if (event.key === forward && index < ids.length - 1) commitMove(entry.operation.id, group.key, ids[index + 2] ?? null);
    // 다시 그려진 같은 Operation에 포커스를 남긴다.
    const id = entry.operation.id;
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`${axis === "x" ? ".zen-taskbar-list" : MENU_SELECTOR} [data-zen-op="${CSS.escape(id)}"]`)?.focus());
  };

  const dragStyle = (id: string): CSSProperties | undefined => {
    if (drag === null || !drag.dragging || drag.id !== id) return undefined;
    return { transform: drag.axis === "x" ? `translateX(${Math.round(drag.offset)}px)` : `translateY(${Math.round(drag.offset)}px)` };
  };

  const accentOf = (operation: OperationNode): string | null => {
    const key = canvas.operationAccent[operation.id] ?? operationAccentFromNode(operation);
    return key ? resolveAccentColor(key) : null;
  };

  const renderOperation = (entry: SideBarEntry, measuring: boolean) => {
    const statusLabel = entry.status === "awaiting" ? t("sidebar.status.awaiting")
      : entry.status === "running" || entry.status === "background" ? t("sidebar.status.running")
        : entry.status === "ended" ? t("zen.taskbar.ended") : t("sidebar.status.idle");
    const dragging = !measuring && drag?.dragging === true && drag.id === entry.operation.id;
    const className = [
      "zen-taskbar-op",
      entry.active ? "is-active" : "",
      !entry.minimized && entry.status !== "ended" ? "is-open" : "",
      entry.status === "awaiting" ? "is-awaiting" : "",
      dragging ? "is-dragging" : "",
      reorderEnabled && !measuring ? "is-reorderable" : "",
    ].filter(Boolean).join(" ");
    const accent = accentOf(entry.operation);
    return (
      <button
        key={entry.operation.id}
        type="button"
        className={className}
        data-zen-op={measuring ? undefined : entry.operation.id}
        // 사이드바 칩처럼 Operation을 고르는 진입점이다 — 누르는 순간 활성 해제가 먼저 돌면 접힌 막대에서
        // 지금 보는 Operation이 사라져 누르기도 끌기도 닿지 않는다(active-operation-surface 유지 표식).
        data-keep-operation-active=""
        aria-current={entry.active ? "true" : undefined}
        aria-label={`${entry.operation.title}, ${statusLabel}`}
        title={entry.operation.title}
        tabIndex={measuring ? -1 : undefined}
        style={{ ...(accent ? { "--user-accent": accent } : {}), ...(measuring ? {} : dragStyle(entry.operation.id)) } as CSSProperties}
        onPointerDown={measuring ? undefined : (event) => beginDrag(event, entry, "x")}
        onKeyDown={measuring ? undefined : (event) => keyboardMove(event, entry, "x")}
        onClick={measuring ? undefined : () => activate(entry)}
      >
        <OperationNameMark operation={entry.operation} status={entry.mark} decorative className="zen-taskbar-op-mark" />
        <span className="zen-taskbar-op-title">{entry.operation.title}</span>
      </button>
    );
  };

  const renderGroupChip = (group: TaskbarGroup) => {
    const awaiting = group.entries.some((entry) => entry.status === "awaiting");
    const expanded = menu?.kind === "group" && menu.key === group.key;
    return (
      <button
        type="button"
        className="zen-taskbar-chip"
        data-zen-drop-chip=""
        style={{ "--group-mark": group.color } as CSSProperties}
        data-zen-taskbar-menu-anchor=""
        aria-haspopup="menu"
        aria-expanded={expanded}
        aria-label={t(awaiting ? "zen.taskbar.groupChipAwaiting" : "zen.taskbar.groupChip", { label: group.label, count: group.entries.length })}
        onClick={(event) => toggleMenu({ kind: "group", key: group.key, anchor: event.currentTarget.getBoundingClientRect() }, event.currentTarget)}
      >
        <span className="zen-taskbar-group-dot" aria-hidden="true" />
        <span className="zen-taskbar-chip-label">{group.label}</span>
        <span className="zen-taskbar-chip-count">{group.entries.length}</span>
        {awaiting ? <span className="zen-taskbar-chip-awaiting" aria-hidden="true" /> : null}
        <UpChevron />
      </button>
    );
  };

  const renderGroups = (mode: "expanded" | "compact", measuring: boolean): ReactNode => taskbarGroups.map((group, index) => (
    <span key={group.key} className="zen-taskbar-group" data-zen-drop-group={measuring ? undefined : group.key}>
      {index > 0 ? <span className="zen-taskbar-sep" aria-hidden="true" /> : null}
      {mode === "compact" && !measuring
        ? <>{renderGroupChip(group)}{group.entries.filter((entry) => entry.active).map((entry) => renderOperation(entry, false))}</>
        : <>
          <span className="zen-taskbar-group-label" data-zen-drop-label="" aria-hidden="true" style={{ "--group-mark": group.color } as CSSProperties}>
            <span className="zen-taskbar-group-dot" />
            {group.label}
          </span>
          {group.entries.map((entry) => renderOperation(entry, measuring))}
        </>}
    </span>
  ));

  const openGroup = menu?.kind === "group" ? taskbarGroups.find((group) => group.key === menu.key) ?? null : null;

  return (
    <nav className="zen-taskbar" aria-label={t("zen.taskbar.aria")}>
      <div className="zen-taskbar-left">
        {theater !== null ? (
          <>
            <button
              type="button"
              className="zen-taskbar-theater"
              data-zen-taskbar-menu-anchor=""
              aria-haspopup="menu"
              aria-expanded={menu?.kind === "theaters"}
              aria-label={t(otherTheaterAwaiting ? "zen.taskbar.theaterPickAwaiting" : "zen.taskbar.theaterPick", { theater: theater.label })}
              onClick={(event) => toggleMenu({ kind: "theaters", anchor: event.currentTarget.getBoundingClientRect() }, event.currentTarget)}
            >
              <span className="zen-taskbar-theater-anchor" aria-hidden="true">
                {theaterInitials(theater.label)}
                {otherTheaterAwaiting ? <span className="zen-taskbar-theater-badge" /> : null}
              </span>
              <span className="zen-taskbar-theater-name">{theater.label}</span>
            </button>
            {/* 일반 사이드바와 같은 상태별 보기 토글 — 모드마다 다른 스위치를 두지 않는다. */}
            <span className="zen-taskbar-axis"><SideBarStatusViewToggle active={statusAxis} /></span>
            <span className="zen-taskbar-sep" aria-hidden="true" />
          </>
        ) : null}
        <div className="zen-taskbar-list" ref={listRef}>
          {theater !== null && taskbarGroups.length === 0
            ? <span className="zen-taskbar-empty">{t("zen.taskbar.empty")}</span>
            : renderGroups(compact ? "compact" : "expanded", false)}
        </div>
        <div className="zen-taskbar-measure" ref={measureRef} aria-hidden="true" inert>
          {renderGroups("expanded", true)}
        </div>
      </div>
      {menu !== null ? createPortal(
        <div
          className="zen-taskbar-menu"
          data-zen-drop-group={menu.kind === "group" ? menu.key : undefined}
          role="menu"
          aria-label={menu.kind === "theaters" ? t("zen.taskbar.theaterMenu") : openGroup?.label}
          style={menuPlacement(menu.anchor)}
        >
          {menu.kind === "theaters"
            ? theaters.map((candidate) => {
              const awaiting = awaitingCountOf(candidate.id);
              const current = candidate.id === activeTheaterId;
              return (
                <button
                  key={candidate.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={current}
                  className="zen-taskbar-menu-item"
                  onClick={() => {
                    setMenu(null);
                    if (!current) onSelectTheater(candidate.id);
                    menuReturnFocusRef.current?.focus();
                  }}
                >
                  <span className={`zen-taskbar-theater-anchor${current ? "" : " is-dim"}`} aria-hidden="true">{theaterInitials(candidate.label)}</span>
                  <span className="zen-taskbar-menu-title">{candidate.label}</span>
                  {awaiting > 0 ? <span className="zen-taskbar-menu-awaiting">{t("zen.taskbar.awaitingCount", { count: awaiting })}</span> : null}
                  <span className="zen-taskbar-menu-count">{operations.filter((operation) => operation.theaterId === candidate.id).length}</span>
                </button>
              );
            })
            : openGroup?.entries.map((entry) => (
              <button
                key={entry.operation.id}
                type="button"
                role="menuitem"
                className={`zen-taskbar-menu-item${entry.active ? " is-active" : ""}${drag?.dragging && drag.id === entry.operation.id ? " is-dragging" : ""}`}
                data-zen-op={entry.operation.id}
                data-keep-operation-active=""
                aria-current={entry.active ? "true" : undefined}
                style={dragStyle(entry.operation.id)}
                onPointerDown={(event) => beginDrag(event, entry, "y")}
                onKeyDown={(event) => keyboardMove(event, entry, "y")}
                onClick={() => activate(entry)}
              >
                <OperationNameMark operation={entry.operation} status={entry.mark} decorative className="zen-taskbar-op-mark" />
                <span className="zen-taskbar-menu-title">{entry.operation.title}</span>
              </button>
            ))}
        </div>,
        document.body,
      ) : null}
      {drag?.dragging && drag.target !== null ? createPortal(
        <span
          className={`zen-taskbar-drop-line is-${drag.target.line.axis}`}
          aria-hidden="true"
          style={drag.target.line.axis === "x"
            ? { left: drag.target.line.left, top: drag.target.line.top, height: drag.target.line.length }
            : { left: drag.target.line.left, top: drag.target.line.top, width: drag.target.line.length }}
        />,
        document.body,
      ) : null}
    </nav>
  );
}

// 메뉴는 막대 위로 연다 — 앵커의 왼쪽 끝에 맞추되 화면 밖으로 넘치지 않게 민다.
function menuPlacement(anchor: DOMRect): CSSProperties {
  const left = Math.max(MENU_GAP, Math.min(anchor.left, window.innerWidth - MENU_WIDTH - MENU_GAP));
  return { left, bottom: window.innerHeight - anchor.top + MENU_GAP, width: MENU_WIDTH };
}

/**
 * 포인터 자리에서 끌기의 도착점을 찾는다. 막대(x축)에서는 묶음 이름의 가운데보다 왼쪽이면 앞 묶음의 끝이고,
 * 그 밖에서는 가운데를 지나지 않은 첫 Operation 앞이다. 접힌 막대에서는 다른 묶음의 칩 위가 그 묶음의 끝이다.
 * 메뉴(y축)는 묶음 하나라 Operation만 본다.
 */
function findDropTarget(container: HTMLElement, axis: "x" | "y", point: number, sourceId: string): DropTarget | null {
  const sections = container.matches("[data-zen-drop-group]")
    ? [container]
    : Array.from(container.querySelectorAll<HTMLElement>("[data-zen-drop-group]"));
  const containerRect = container.getBoundingClientRect();
  const lineAt = (at: number): DropTarget["line"] => axis === "x"
    ? { axis, left: at, top: containerRect.top + 4, length: containerRect.height - 8 }
    : { axis, left: containerRect.left + 6, top: at, length: containerRect.width - 12 };
  // 접힌 막대 — 묶음은 「이름 + 개수」 칩 하나로 선다. 칩 위에 놓으면 그 묶음의 끝으로 옮긴다.
  // 끌고 있는 Operation이 든 제 묶음의 칩은 도착점이 아니다(제자리).
  const chips = sections.flatMap((section) => {
    const chip = section.querySelector<HTMLElement>("[data-zen-drop-chip]");
    return chip === null ? [] : [{ section, chip }];
  });
  if (chips.length > 0) {
    for (const { section, chip } of chips) {
      if (section.querySelector(`[data-zen-op="${CSS.escape(sourceId)}"]`) !== null) continue;
      const rect = chip.getBoundingClientRect();
      const start = axis === "x" ? rect.left : rect.top;
      const end = axis === "x" ? rect.right : rect.bottom;
      if (point >= start && point <= end) return { groupKey: section.dataset.zenDropGroup!, beforeId: null, line: lineAt(end + 1) };
    }
    return null;
  }
  let previous: { readonly key: string; readonly end: number } | null = null;
  for (const section of sections) {
    const key = section.dataset.zenDropGroup!;
    const label = section.querySelector<HTMLElement>("[data-zen-drop-label]");
    if (previous !== null && label !== null) {
      const rect = label.getBoundingClientRect();
      if (point < rect.left + rect.width / 2) return { groupKey: previous.key, beforeId: null, line: lineAt(previous.end) };
    }
    const items = Array.from(section.querySelectorAll<HTMLElement>("[data-zen-op]")).filter((item) => item.dataset.zenOp !== sourceId);
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      const start = axis === "x" ? rect.left : rect.top;
      const size = axis === "x" ? rect.width : rect.height;
      if (point < start + size / 2) return { groupKey: key, beforeId: item.dataset.zenOp!, line: lineAt(start - 1) };
    }
    const last = items[items.length - 1]?.getBoundingClientRect() ?? label?.getBoundingClientRect() ?? null;
    previous = { key, end: last === null ? (axis === "x" ? containerRect.left : containerRect.top) : (axis === "x" ? last.right + 1 : last.bottom + 1) };
  }
  return previous === null ? null : { groupKey: previous.key, beforeId: null, line: lineAt(previous.end) };
}

function UpChevron() {
  return <svg className="zen-taskbar-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 10 4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
