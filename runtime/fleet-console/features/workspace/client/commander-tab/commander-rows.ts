import { useMemo, useSyncExternalStore } from "react";

import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { useT } from "../../../../core/client/src/i18n/index.js";
import { objectiveRecordOrderFromNodes } from "../../../../core/client/src/integration/store.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "../../../execution/client/objective-marks.js";
import { commanderObjectiveId, indexClusters, useClusterIndex } from "../objective-clusters.js";
import type { ObjectiveCluster } from "../../../objectives/shared/objective-clusters.js";
import { buildTheaterEntries, sideBarRowItems, type SideBarRowItem } from "../sidebar/side-bar-cluster-row.js";
import { isNotStartedRow } from "../conversation/new-session-mention.js";
import type { CommanderFold } from "./commander-folds.js";
import { sortCommanderRows, useSortPreference } from "./commander-sort.js";

export interface CommanderSection {
  readonly id: string;
  readonly title: string | null;
  readonly rows: readonly SideBarRowItem[];
  /** 시작 전·완료만 접힌다. 그룹 제목은 접지 않는다. */
  readonly fold: CommanderFold | null;
  /** 데스크톱 명단의 시작 전·완료 통합 목록 — 구분 머리(접기 단추) 아래 한 줄짜리 행으로 선다. */
  readonly settled?: true;
}

/**
 * 우측 펼침의 유지 주인 — 레일이 이 사령관의 작업 탭에 머물 때 그 사령관 id. 펼침 행의 패널과 레일 머리가 함께 읽는다.
 * 우측 배치이고, 레일이 보여 주는 패널 주인의 지휘관이 가운데일 때만 그 주인이다.
 */
export function keptCommodoreOwnerOf(placement: "left" | "right", panelOwner: string | null, centerIsOwnerCommander: boolean): string | null {
  if (placement !== "right" || panelOwner === null || !centerIsOwnerCommander) return null;
  return panelOwner;
}

/**
 * 가운데 objectiveId가 이 사령관의 지휘관인가 — 시작 전(avatarObjectiveId)·완료 포함.
 * 우측 펼침의 행 펼치기와 레일 유지가 함께 읽는 판정이다. 묶음 선언이 없는 Objective 은 지휘관이 아니다.
 */
export function isCommanderObjective(clusters: readonly ObjectiveCluster[], commodoreId: string, objectiveId: string): boolean {
  for (const layout of indexClusters(clusters).rows) {
    if (commanderObjectiveId(layout.cluster) !== objectiveId) continue;
    if (layout.cluster.commodoreId === undefined || layout.cluster.commodoreId === commodoreId) return true;
  }
  return false;
}

/**
 * 시작 전·완료 통합 목록의 순서 — 지난 기한 → 가까운 기한 → 기한 없음 → 완료(최근 완료가 위). 기한 없는 것을 앞에 두면 기한 걸린
 * 목표가 묻힌다. 같은 자리끼리는 정렬 메뉴의 순서를 지킨다(안정 정렬).
 */
function settledOrder(fresh: readonly SideBarRowItem[], done: readonly SideBarRowItem[]): SideBarRowItem[] {
  const dated = fresh.filter((item) => item.row.due).sort((a, b) => a.row.due!.date.localeCompare(b.row.due!.date));
  const undated = fresh.filter((item) => !item.row.due);
  const finished = [...done].sort((a, b) => (b.row.doneAt ?? 0) - (a.row.doneAt ?? 0));
  return [...dated, ...undated, ...finished];
}

/**
 * 데스크톱과 폰의 지휘관 명단. 폰(`sections`)은 시작 전·완료를 정렬·그룹과 상관없이 같은 정렬의 접는 구역으로 두고,
 * 데스크톱 목록과 레일(`listSections`)은 둘을 자체 순서의 통합 목록 하나로 둔다.
 */
export function useCommanderRows(commodoreId: string, selectedId: string | null) {
  const t = useT();
  const state = useConsoleState();
  const clusterIndex = useClusterIndex();
  const preference = useSortPreference();
  const idleArrivalIds = useSyncExternalStore(subscribeIdleArrival, getIdleArrivalIds, getIdleArrivalIds);
  const items = useMemo(() => {
    const records = state.objectiveRecords.filter((objectiveRecord) => objectiveRecord.commodoreId === commodoreId);
    const entries = buildTheaterEntries({
      theaterId: commodoreId,
      objectiveRecords: records,
      objectiveRecordOrder: objectiveRecordOrderFromNodes(records),
      activeObjectiveId: selectedId,
      objectiveRecordNotifications: state.objectiveRecordNotifications,
      objectiveRecordRuntime: state.objectiveRecordRuntime,
    });
    return sideBarRowItems(entries, clusterIndex, new Set(records.map((objectiveRecord) => objectiveRecord.id)), commodoreId);
  }, [clusterIndex, commodoreId, idleArrivalIds, selectedId, state.objectiveRecordNotifications, state.objectiveRecordRuntime, state.objectiveRecords]);
  const sorted = useMemo(() => sortCommanderRows(items, preference), [items, preference]);
  const fresh = sorted.filter((item) => isNotStartedRow(item.row));
  const done = sorted.filter((item) => item.row.glyph === "done");
  const active = sorted.filter((item) => item.row.glyph !== "done" && !isNotStartedRow(item.row));
  const groups = [...state.groups].filter((group) => group.commodoreId === commodoreId).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  const groupIdOf = (item: SideBarRowItem) => item.anchor ? item.anchor.objectiveRecord.groupId ?? null : item.row.groupId;
  const groupIds = new Set(groups.map((group) => group.id));
  const activeSections: CommanderSection[] = preference.grouped
    ? [...groups.map((group) => ({ id: group.id, title: group.name, rows: active.filter((item) => groupIdOf(item) === group.id), fold: null })),
      { id: "ungrouped", title: t("commanderTab.ungrouped"), rows: active.filter((item) => !groupIds.has(groupIdOf(item) ?? "")), fold: null }].filter((group) => group.rows.length > 0)
    : active.length > 0 ? [{ id: "active", title: null, rows: active, fold: null }] : [];
  const sections: CommanderSection[] = [
    ...activeSections,
    ...(fresh.length > 0 ? [{ id: "fresh", title: t("sidebar.row.glyph.fresh"), rows: fresh, fold: "fresh" as const }] : []),
    ...(done.length > 0 ? [{ id: "done", title: t("sidebar.row.glyph.done"), rows: done, fold: "done" as const }] : []),
  ];
  const settled = settledOrder(fresh, done);
  const listSections: CommanderSection[] = [
    ...activeSections,
    ...(settled.length > 0 ? [{ id: "settled", title: null, rows: settled, fold: "settled" as const, settled: true as const }] : []),
  ];
  // 이 사령관의 기록이 아직 오지 않았거나, 기록은 있는데 줄이 아직 서지 않았으면(묶음 원천 설치 전) 빈 상태가 아니다.
  const settledEmpty = sorted.length === 0 && state.objectiveRecordsHydrated
    && !state.objectiveRecords.some((objectiveRecord) => objectiveRecord.commodoreId === commodoreId);
  return { sorted, sections, listSections, preference, settledEmpty };
}
