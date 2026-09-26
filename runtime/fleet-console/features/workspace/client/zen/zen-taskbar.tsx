import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { OperationRuntimeState } from "@fleet-console/sdk/plugin";

import { useT } from "../../../../core/client/src/i18n/index.js";
import type { OperationGroup, OperationNode, OperationNotification, TheaterInfo } from "../../../../core/client/src/integration/types.js";
import { operationOrderFromNodes, sortOperationsByOrder } from "../../../../core/client/src/integration/store.js";
import { OperationNameMark } from "../../../execution/client/components/operation-name-mark.js";
import { resolveOperationActivity, resolveOperationDisplayActivity, resolveOperationMarkVisual } from "../../../execution/client/operation-activity.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "../../../execution/client/operation-marks.js";
import { groupOperations, groupOperationsByStatus, theaterInitials } from "../sidebar/operations-side-bar.js";
import type { SideBarEntry } from "../sidebar/operations-side-bar-chip.js";
import { getStatusTransitionTick, setSideBarStatusAxis, useSideBarStatusAxis } from "../sidebar/operations-side-bar-store.js";
import { useContextMenuKeyboard } from "../sidebar/context-menu-keyboard.js";
import "./zen-taskbar.css";

/**
 * Zen 작업 표시줄 — Zen이 좌측 사이드바를 걷은 자리를 화면 아래 한 줄이 잇는다.
 *
 * 왼쪽은 지금 Theater의 Operation 목록이다. Theater는 글리프를 눌러 위로 여는 메뉴에서 바꾸고,
 * 목록은 사이드바와 같은 축 스위치(상태별 보기, Alt+S)를 따라 상태 또는 사용자 그룹으로 나뉜다.
 * 막대가 모자라면 모든 묶음을 「이름 + 개수」 칩으로 접고, 지금 보는 Operation 하나만 자기
 * 묶음 칩 옆에 이름째 남긴다 — Operation이 몇 개로 늘어도 막대 길이가 묶음 수에만 비례한다.
 *
 * 오른쪽 끝의 도구·Zen 끄기·Fleet 앰블럼은 트레이(core zen-bar)가 진다. 막대는 Operations 페이지
 * 소속이라 작업 목록만 알고, 트레이는 콘솔 크롬이라 경로와 무관하게 플러그인 슬롯을 지킨다. 트레이가
 * 막대 위 오른쪽에 겹쳐 서므로 막대는 --zen-bar-width만큼 오른쪽을 비워 둔다.
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
}

interface TaskbarGroup {
  readonly key: string;
  readonly label: string;
  readonly entries: readonly SideBarEntry[];
}

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
}: ZenTaskbarProps) {
  const t = useT();
  const statusAxis = useSideBarStatusAxis();
  const idleArrivalIds = useSyncExternalStore(subscribeIdleArrival, getIdleArrivalIds, getIdleArrivalIds);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [compact, setCompact] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const menuReturnFocusRef = useRef<HTMLElement | null>(null);

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
      .map((section) => ({ key: `status:${section.status}`, label: section.status === "ended" ? t("zen.taskbar.ended") : section.label, entries: section.entries }))
    : groupOperations(entries, groups.filter((group) => group.theaterId === activeTheaterId), order)
      .filter((section) => section.entries.length > 0)
      .map((section) => ({
        key: `group:${section.groupId ?? "none"}`,
        label: section.group?.name ?? t("sidebar.ungrouped.label"),
        entries: section.entries,
      }));

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
    setMenu(null);
    if (entry.status === "ended") onResume(entry.operation.id);
    else onFocus(entry.operation.id);
  };

  const renderOperation = (entry: SideBarEntry, measuring: boolean) => {
    const statusLabel = entry.status === "awaiting" ? t("sidebar.status.awaiting")
      : entry.status === "running" || entry.status === "background" ? t("sidebar.status.running")
        : entry.status === "ended" ? t("zen.taskbar.ended") : t("sidebar.status.idle");
    const className = [
      "zen-taskbar-op",
      entry.active ? "is-active" : "",
      !entry.minimized && entry.status !== "ended" ? "is-open" : "",
      entry.status === "awaiting" ? "is-awaiting" : "",
    ].filter(Boolean).join(" ");
    return (
      <button
        key={entry.operation.id}
        type="button"
        className={className}
        aria-current={entry.active ? "true" : undefined}
        aria-label={`${entry.operation.title}, ${statusLabel}`}
        title={entry.operation.title}
        tabIndex={measuring ? -1 : undefined}
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
        data-zen-taskbar-menu-anchor=""
        aria-haspopup="menu"
        aria-expanded={expanded}
        aria-label={t(awaiting ? "zen.taskbar.groupChipAwaiting" : "zen.taskbar.groupChip", { label: group.label, count: group.entries.length })}
        onClick={(event) => toggleMenu({ kind: "group", key: group.key, anchor: event.currentTarget.getBoundingClientRect() }, event.currentTarget)}
      >
        <span className="zen-taskbar-chip-label">{group.label}</span>
        <span className="zen-taskbar-chip-count">{group.entries.length}</span>
        {awaiting ? <span className="zen-taskbar-chip-awaiting" aria-hidden="true" /> : null}
        <UpChevron />
      </button>
    );
  };

  const renderGroups = (mode: "expanded" | "compact", measuring: boolean): ReactNode => taskbarGroups.map((group, index) => (
    <span key={group.key} className="zen-taskbar-group">
      {index > 0 ? <span className="zen-taskbar-sep" aria-hidden="true" /> : null}
      {mode === "compact" && !measuring
        ? <>{renderGroupChip(group)}{group.entries.filter((entry) => entry.active).map((entry) => renderOperation(entry, false))}</>
        : <><span className="zen-taskbar-group-label" aria-hidden="true">{group.label}</span>{group.entries.map((entry) => renderOperation(entry, measuring))}</>}
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
              <UpChevron />
            </button>
            <div className="zen-taskbar-axis" role="radiogroup" aria-label={t("zen.taskbar.axisAria")}>
              <button type="button" role="radio" aria-checked={statusAxis} onClick={() => setSideBarStatusAxis(true)}>{t("zen.taskbar.axisStatus")}</button>
              <button type="button" role="radio" aria-checked={!statusAxis} onClick={() => setSideBarStatusAxis(false)}>{t("zen.taskbar.axisGroup")}</button>
            </div>
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
                className={`zen-taskbar-menu-item${entry.active ? " is-active" : ""}`}
                aria-current={entry.active ? "true" : undefined}
                onClick={() => activate(entry)}
              >
                <OperationNameMark operation={entry.operation} status={entry.mark} decorative className="zen-taskbar-op-mark" />
                <span className="zen-taskbar-menu-title">{entry.operation.title}</span>
              </button>
            ))}
        </div>,
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

function UpChevron() {
  return <svg className="zen-taskbar-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 10 4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
