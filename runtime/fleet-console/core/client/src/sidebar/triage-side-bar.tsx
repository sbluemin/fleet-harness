import { useEffect, useState, useSyncExternalStore, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { OperationCatalogPlugin, OperationLaunchKind } from "@fleet-console/sdk/operations";
import type { FleetClientPlugin, OperationActivity } from "@fleet-console/sdk/plugin";

import { useT } from "../i18n/index.js";
import { CanvasContextMenu } from "../canvas/canvas-context-menu.js";
import { resumeOperationInPlace } from "../operation-resume.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "../operation-idle-arrival.js";
import type { OperationNode, OperationNotification } from "../types.js";
import { getTheaterCanvasSnapshot, getTheaterMinimizedIds, setTheaterOperationMinimized } from "../canvas/canvas-store.js";
import { resolveOperationActivity } from "../operation-activity.js";
import { operationAccentFromNode, resolveAccentColor } from "../canvas/operation-accent.js";
import type { TriageDeckTheater } from "../canvas/triage-watch-deck.js";
import { getTriagePick, getTriageSnapshot, resolveTriageQueue, subscribeTriage, type TriageQueueEntry } from "../canvas/triage-store.js";
import { OperationsSideBarChip, type SideBarEntry } from "./operations-side-bar-chip.js";
import { buildTheaterEntries, groupOperationsByStatus, StatusSectionSlot, type StatusSection } from "./operations-side-bar.js";
import { useSideBarState } from "./operations-side-bar-store.js";
import { SideBarResizeHandle, useSideBarResize } from "./side-bar-resize.js";

// 선별 사이드바의 상태 섹션은 Map 사이드바 STATUS 축과 같은 collapse 저장소를 쓰되,
// Theater 키가 아니라 전역 선별 고유 키 하나로 접힘을 기억한다.
const TRIAGE_SIDE_BAR_SECTION_KEY = "__triage__";
const EMPTY_MINIMIZED: ReadonlySet<string> = new Set();

// 전역 선별 목록도 Map 사이드바의 표현 문법(상태 섹션 헤더 + 칩)을 그대로 쓴다 — 모드가 바뀌어도
// 왼쪽 열의 읽는 법이 바뀌지 않아야 한다. 네 living 섹션은 큐 문법을 공유하되, 휴면은 큐에 합류하지
// 않고 하단 선반에만 머문다. 대기 섹션은 전역 큐의 처리 순서를 따른다.
export function resolveTriageSideBarSections(
  entries: readonly SideBarEntry[],
  queue: readonly TriageQueueEntry[],
  t?: Parameters<typeof groupOperationsByStatus>[2],
): StatusSection[] {
  const queueIndexById = new Map(queue.map((entry, index) => [entry.operation.id, index]));
  return groupOperationsByStatus(entries, undefined, t).map((section) => section.status !== "awaiting"
    ? section
    : {
        ...section,
        entries: [...section.entries].sort((left, right) =>
          (queueIndexById.get(left.operation.id) ?? Number.MAX_SAFE_INTEGER)
          - (queueIndexById.get(right.operation.id) ?? Number.MAX_SAFE_INTEGER)),
      });
}

interface TriageSideBarProps {
  readonly theaters: readonly TriageDeckTheater[];
  readonly operations: readonly OperationNode[];
  readonly operationStatus: Readonly<Record<string, OperationActivity>>;
  readonly operationNotifications: Readonly<Record<string, OperationNotification>>;
  readonly catalog: readonly OperationCatalogPlugin[];
  readonly plugins: readonly FleetClientPlugin[];
  readonly renderKindIcon: (pluginId: string, kind: OperationLaunchKind) => ReactNode;
  readonly canLaunch: boolean;
  /** 소유자 없는 자리의 실행 대상 — 사이드바 빈 영역은 활성 Theater로 실행한다. */
  readonly activeTheaterLabel?: string;
  readonly onLaunchKind: (pluginId: string, kind: OperationLaunchKind, variantLaunch?: Readonly<Record<string, string>>) => void;
  readonly onPick: (operationId: string) => void;
  readonly onClose: (operationId: string) => void;
  readonly onRename: (operationId: string, title: string) => void;
  readonly onOpenOperationMenu?: (operationId: string, anchor: DOMRect, returnFocus?: HTMLElement | null) => void;
}

export function TriageSideBar({
  theaters,
  operations,
  operationStatus,
  operationNotifications,
  catalog,
  plugins,
  renderKindIcon,
  canLaunch,
  activeTheaterLabel,
  onLaunchKind,
  onPick,
  onClose,
  onRename,
  onOpenOperationMenu,
}: TriageSideBarProps) {
  const t = useT();
  // 지목·미룸·치워둠은 콘솔 상태를 바꾸지 않는 store 단독 변화다 — 캔버스와 같은 리비전 구독으로
  // 사이드바도 함께 리렌더한다. 유휴 도착도 awaiting 섹션 판정에 관여하므로 같이 구독한다.
  useSyncExternalStore(subscribeTriage, getTriageSnapshot, getTriageSnapshot);
  useSyncExternalStore(subscribeIdleArrival, getIdleArrivalIds, getIdleArrivalIds);
  // 접힘/폭은 Map 사이드바와 같은 좌측 열 상태를 공유한다 — 커맨드 밴드의 사이드바 토글이
  // 선별 중에도 계속 동작해야 하고, 모드 전환이 사용자의 접힘 선택을 잃지 않아야 한다.
  const sideBar = useSideBarState();
  const { resizing, onPointerDown: onResizePointerDown, onDoubleClick: onResizeDoubleClick } = useSideBarResize();
  const [armedCloseId, setArmedCloseId] = useState<string | null>(null);
  const [launchMenu, setLaunchMenu] = useState<{
    readonly anchor: { readonly x: number; readonly y: number };
    readonly viewportBounds: { readonly width: number; readonly height: number };
  } | null>(null);
  // 메뉴는 포털(document.body)이라 <aside>의 inert가 닿지 않는다 — 좌측 열을 접으면 그 열이 연
  // 메뉴도 함께 걷어야 한다. 아니면 사라진 사이드바의 메뉴가 화면에 남아 실행까지 받는다.
  useEffect(() => {
    if (sideBar.collapsed) setLaunchMenu(null);
  }, [sideBar.collapsed]);
  // 사이드바 빈 영역 우클릭 = 캔버스의 주인 없는 자리와 같은 '캔버스 제어'를 커서 자리에 연다.
  // 칩과 휴면 선반은 자기 우클릭에서 preventDefault()를 부르므로(버블로 도달 시 defaultPrevented=true)
  // 그쪽 계약은 그대로 유지되고 여기서는 무시된다.
  const openLaunchMenuAtCursor = (event: MouseEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    // 캔버스가 소유한 메뉴는 이 <aside> 안에 없어 포털의 mousedown 외부-클릭 닫기가 못 잡는다 —
    // 포털이 구독하는 닫기 신호를 함께 보낸다.
    window.dispatchEvent(new Event("canvas-context-menu-close"));
    setLaunchMenu({
      anchor: { x: event.clientX, y: event.clientY },
      viewportBounds: { width: window.innerWidth, height: window.innerHeight },
    });
  };
  const queue = resolveTriageQueue(operations, operationStatus);
  const stagedOperationId = getTriagePick() ?? queue[0]?.operation.id ?? null;
  const theaterLabelById = new Map(theaters.map((theater) => [theater.id, theater.label]));
  const entries = theaters.flatMap((theater) => buildTheaterEntries({
    theaterId: theater.id,
    operations,
    operationOrder: getTheaterCanvasSnapshot(theater.id).operationOrder,
    minimizedSet: EMPTY_MINIMIZED,
    activeOperationId: stagedOperationId,
    operationNotifications,
    operationStatus,
    catalog,
    renderKindIcon,
  }));
  // 최소화한 Operation은 상태 축에서 내려와 전용 선반으로 모인다 — 최소화는 활동 상태가 아니라
  // 표시 선택이므로 대기·실행 중·백그라운드·유휴 중 어디에도 새 칸을 만들지 않는다.
  // 휴면은 그대로 휴면 선반이 가져간다: 재개 대기는 사용자가 고른 상태가 아니라 세션의 상태다.
  const minimizedIds = new Set(getTheaterMinimizedIds(theaters.map((theater) => theater.id)));
  const isDormantEntry = (entry: SideBarEntry): boolean =>
    resolveOperationActivity(entry.operation, operationStatus) === "dormant";
  const minimizedEntries = entries.filter((entry) => minimizedIds.has(entry.operation.id) && !isDormantEntry(entry));
  const minimizedSection: StatusSection = {
    status: "minimized",
    label: t("triageSidebar.minimized"),
    entries: minimizedEntries,
  };
  const shelvedIds = new Set(minimizedEntries.map((entry) => entry.operation.id));
  const sections = resolveTriageSideBarSections(entries.filter((entry) => !shelvedIds.has(entry.operation.id)), queue, t);
  const livingSections = sections.filter((section) => section.status !== "dormant");
  const dormantSection = sections.find((section) => section.status === "dormant");
  const renderChip = (entry: SideBarEntry, index: number, shelf: "none" | "dormant" | "minimized" = "none") => {
    const dormant = shelf === "dormant";
    const accentKey = getTheaterCanvasSnapshot(entry.operation.theaterId).operationAccent[entry.operation.id]
      ?? operationAccentFromNode(entry.operation);
    // 휴면 plugin에 resume 훅이 없으면 지목해 dormant 프레임의 자체 재개 UI를 보인다 —
    // onPick은 알림을 지우거나 Theater를 바꾸지 않고, picked 항목은 live-only deck와 별개로 무대에 선다.
    // 최소화 선반의 본동작은 되올리기다 — 무대에 세우지 않고 deck으로만 돌려보낸다. 지목했다면 최소화가
    // 큐에서 걸러내므로 무대에 서지도 못한 채 선반에 남는다.
    const activate = dormant
      ? (operationId: string) => resumeOperationInPlace(operationId, operations, plugins, onPick)
      : shelf === "minimized"
        ? () => setTheaterOperationMinimized(entry.operation.theaterId, entry.operation.id, false)
        : onPick;
    return (
      <OperationsSideBarChip
        key={entry.operation.id}
        entry={entry}
        index={index}
        isCloseArmed={armedCloseId === entry.operation.id}
        accentValue={accentKey ? resolveAccentColor(accentKey) : null}
        theaterName={theaterLabelById.get(entry.operation.theaterId) ?? entry.operation.theaterId}
        statusAxis
        reorderEnabled={false}
        minimizeEnabled={false}
        menuEnabled={!dormant && onOpenOperationMenu !== undefined}
        resumeOnActivate={dormant}
        dragging={false}
        dragOffsetY={0}
        dropTarget={false}
        onArmClose={setArmedCloseId}
        onDisarmClose={() => setArmedCloseId(null)}
        onClose={onClose}
        onMinimize={() => {}}
        onFocus={activate}
        onKeyboardMove={() => {}}
        onPointerDragStart={() => {}}
        onOpenAccent={(operationId, anchor, returnFocus) => onOpenOperationMenu?.(operationId, anchor, returnFocus)}
        onRename={onRename}
      />
    );
  };
  return (
    <aside
      className={`operations-side-bar triage-side-bar ${sideBar.collapsed ? "is-closed" : "is-expanded"}`}
      data-canvas-blocker
      data-sidebar-state={sideBar.collapsed ? "closed" : "expanded"}
      data-resizing={resizing ? "true" : undefined}
      style={{ "--side-bar-width": `${sideBar.width}px` } as CSSProperties}
      inert={sideBar.collapsed}
      aria-label={t("triageSidebar.aria")}
      onContextMenu={openLaunchMenuAtCursor}
    >
      {/* 상태 섹션은 비어 있어도 항상 선다 — 대기·실행 중·백그라운드·유휴는 War Room이 읽는
          축 자체라, 건수가 0이라고 축이 사라지면 좌측 열의 읽는 법이 상황에 따라 달라진다.
          "없음"은 빈 섹션의 자체 힌트가 말한다(전역 empty 문구는 이 계약으로 퇴역했다). */}
      <ol className="operations-side-bar-chips triage-side-bar-sections" aria-label={t("triageSidebar.aria")}>
        {livingSections.map((section) => (
          <StatusSectionSlot key={section.status} theaterId={TRIAGE_SIDE_BAR_SECTION_KEY} section={section}>
            {section.entries.map((entry, index) => renderChip(entry, index))}
          </StatusSectionSlot>
        ))}
      </ol>
      {/* 최소화 선반은 휴면 선반과 같은 문법을 쓰되 그 위에 선다 — 내가 직접 내린 것이 세션이 스스로
          잠든 것보다 손에 가깝다. 휴면처럼 0건이어도 자리를 지킨다: 되찾을 곳이 상황에 따라 나타났다
          사라지면 어디를 봐야 하는지가 매번 달라진다. */}
      <section className="triage-side-bar-minimized-shelf" onContextMenu={(event) => event.preventDefault()}>
        <p className="triage-side-bar-caption">{t("triageSidebar.minimizedShelf")}</p>
        <ol className="triage-side-bar-minimized-list" aria-label={t("triageSidebar.minimizedShelf")}>
          <StatusSectionSlot theaterId={TRIAGE_SIDE_BAR_SECTION_KEY} section={minimizedSection}>
            {minimizedEntries.map((entry, index) => renderChip(entry, index, "minimized"))}
          </StatusSectionSlot>
        </ol>
      </section>
      {/* 선반의 칩은 Operation 메뉴를 갖지 않는다(본동작이 재개다) — 그렇다고 브라우저 메뉴가 뜨면
          "이 표면에는 메뉴가 없다"가 아니라 "우리 것이 아니다"로 읽힌다. 큐의 칩과 달리 여기서는
          아무것도 열지 않는다. menuEnabled=false는 핸들러를 떼기만 하므로 선반이 직접 막는다. */}
      {dormantSection ? (
        <footer className="triage-side-bar-dormant-shelf" onContextMenu={(event) => event.preventDefault()}>
          <p className="triage-side-bar-caption">{t("triageSidebar.dormantShelf")}</p>
          <ol className="triage-side-bar-dormant-list" aria-label={t("triageSidebar.dormantShelf")}>
            <StatusSectionSlot
              theaterId={TRIAGE_SIDE_BAR_SECTION_KEY}
              section={dormantSection}
              defaultCollapsed
            >
              {dormantSection.entries.map((entry, index) => renderChip(entry, index, "dormant"))}
            </StatusSectionSlot>
          </ol>
        </footer>
      ) : null}
      <SideBarResizeHandle onPointerDown={onResizePointerDown} onDoubleClick={onResizeDoubleClick} />

      {launchMenu ? createPortal(
        <CanvasContextMenu
          key={`${launchMenu.anchor.x}:${launchMenu.anchor.y}`}
          anchor={launchMenu.anchor}
          viewportBounds={launchMenu.viewportBounds}
          placement="cursor"
          catalog={catalog}
          canLaunch={canLaunch}
          renderKindIcon={renderKindIcon}
          onLaunchKind={(pluginId, kind, variantLaunch) => { setLaunchMenu(null); onLaunchKind(pluginId, kind, variantLaunch); }}
          onClose={() => setLaunchMenu(null)}
          theaterLabel={activeTheaterLabel}
        />,
        document.body,
      ) : null}
    </aside>
  );
}
