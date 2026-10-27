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
}

/** 데스크톱과 폰의 지휘관 명단. 시작 전·완료는 정렬·그룹과 상관없이 같은 정렬의 별도 구역이다. */
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
  return { sorted, sections, preference };
}
