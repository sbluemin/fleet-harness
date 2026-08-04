import { useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";

import type { OperationCatalogPlugin, OperationLaunchKind } from "@fleet-console/sdk/operations";
import type { OperationActivity } from "@fleet-console/sdk/plugin";

import { useT } from "../i18n/index.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "../operation-idle-arrival.js";
import type { OperationNode, OperationNotification } from "../types.js";
import { getTheaterCanvasSnapshot } from "../canvas/canvas-store.js";
import { operationAccentFromNode, resolveAccentColor } from "../canvas/operation-accent.js";
import type { TriageDeckTheater } from "../canvas/triage-watch-deck.js";
import { getTriagePick, getTriageSnapshot, resolveTriageQueue, subscribeTriage, type TriageQueueEntry } from "../canvas/triage-store.js";
import { OperationsSideBarChip, type SideBarEntry } from "./operations-side-bar-chip.js";
import { buildTheaterEntries, groupOperationsByStatus, StatusSectionSlot, type StatusSection } from "./operations-side-bar.js";
import { useSideBarState } from "./operations-side-bar-store.js";

// 선별 사이드바의 상태 섹션은 Map 사이드바 STATUS 축과 같은 collapse 저장소를 쓰되,
// Theater 키가 아니라 전역 선별 고유 키 하나로 접힘을 기억한다.
const TRIAGE_SIDE_BAR_SECTION_KEY = "__triage__";
const EMPTY_MINIMIZED: ReadonlySet<string> = new Set();

// 전역 선별 목록도 Map 사이드바의 표현 문법(상태 섹션 헤더 + 칩)을 그대로 쓴다 — 모드가 바뀌어도
// 왼쪽 열의 읽는 법이 바뀌지 않아야 한다. 선별 고유 규칙은 두 가지뿐이다: 휴면 섹션은 싣지 않고
// (deck와 같은 "살아있는 함대" 계약), 대기 섹션은 전역 큐의 처리 순서를 따른다.
export function resolveTriageSideBarSections(
  entries: readonly SideBarEntry[],
  queue: readonly TriageQueueEntry[],
  t?: Parameters<typeof groupOperationsByStatus>[2],
): StatusSection[] {
  const queueIndexById = new Map(queue.map((entry, index) => [entry.operation.id, index]));
  return groupOperationsByStatus(entries, undefined, t)
    .filter((section) => section.status !== "dormant")
    .map((section) => section.status !== "awaiting"
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
  readonly renderKindIcon: (pluginId: string, kind: OperationLaunchKind) => ReactNode;
  readonly onPick: (operationId: string) => void;
  readonly onClose: (operationId: string) => void;
  readonly onRename: (operationId: string, title: string) => void;
}

export function TriageSideBar({
  theaters,
  operations,
  operationStatus,
  operationNotifications,
  catalog,
  renderKindIcon,
  onPick,
  onClose,
  onRename,
}: TriageSideBarProps) {
  const t = useT();
  // 지목·미룸·치워둠은 콘솔 상태를 바꾸지 않는 store 단독 변화다 — 캔버스와 같은 리비전 구독으로
  // 사이드바도 함께 리렌더한다. 유휴 도착도 awaiting 섹션 판정에 관여하므로 같이 구독한다.
  useSyncExternalStore(subscribeTriage, getTriageSnapshot, getTriageSnapshot);
  useSyncExternalStore(subscribeIdleArrival, getIdleArrivalIds, getIdleArrivalIds);
  // 접힘/폭은 Map 사이드바와 같은 좌측 열 상태를 공유한다 — 커맨드 밴드의 사이드바 토글이
  // 선별 중에도 계속 동작해야 하고, 모드 전환이 사용자의 접힘 선택을 잃지 않아야 한다.
  const sideBar = useSideBarState();
  const [armedCloseId, setArmedCloseId] = useState<string | null>(null);
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
  const sections = resolveTriageSideBarSections(entries, queue, t);
  return (
    <aside
      className={`operations-side-bar triage-side-bar ${sideBar.collapsed ? "is-closed" : "is-expanded"}`}
      data-canvas-blocker
      data-sidebar-state={sideBar.collapsed ? "closed" : "expanded"}
      style={{ "--side-bar-width": `${sideBar.width}px` } as CSSProperties}
      inert={sideBar.collapsed}
      aria-label={t("triageSidebar.aria")}
    >
      {/* 상태 섹션은 비어 있어도 항상 선다 — 대기·실행 중·백그라운드·유휴는 War Room이 읽는
          축 자체라, 건수가 0이라고 축이 사라지면 좌측 열의 읽는 법이 상황에 따라 달라진다.
          "없음"은 빈 섹션의 자체 힌트가 말한다(전역 empty 문구는 이 계약으로 퇴역했다). */}
      <ol className="operations-side-bar-chips triage-side-bar-sections" aria-label={t("triageSidebar.aria")}>
        {sections.map((section) => (
          <StatusSectionSlot key={section.status} theaterId={TRIAGE_SIDE_BAR_SECTION_KEY} section={section}>
            {section.entries.map((entry, index) => {
              const accentKey = getTheaterCanvasSnapshot(entry.operation.theaterId).operationAccent[entry.operation.id]
                ?? operationAccentFromNode(entry.operation);
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
                  menuEnabled={false}
                  dragging={false}
                  dragOffsetY={0}
                  dropTarget={false}
                  onArmClose={setArmedCloseId}
                  onDisarmClose={() => setArmedCloseId(null)}
                  onClose={onClose}
                  onMinimize={() => {}}
                  onFocus={onPick}
                  onKeyboardMove={() => {}}
                  onPointerDragStart={() => {}}
                  onOpenAccent={() => {}}
                  onRename={onRename}
                />
              );
            })}
          </StatusSectionSlot>
        ))}
      </ol>
    </aside>
  );
}
