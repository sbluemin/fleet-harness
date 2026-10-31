import { useMemo, useSyncExternalStore } from "react";

import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { useT } from "../../../../core/client/src/i18n/index.js";
import { objectiveRecordOrderFromNodes } from "../../../../core/client/src/integration/store.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "../../../execution/client/objective-marks.js";
import { useClusterIndex } from "../objective-clusters.js";
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
