import { useMemo, useSyncExternalStore } from "react";

import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { useT } from "../../../../core/client/src/i18n/index.js";
import { objectiveRecordOrderFromNodes } from "../../../../core/client/src/integration/store.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "../../../execution/client/objective-marks.js";
import { useClusterIndex } from "../objective-clusters.js";
import { buildTheaterEntries, sideBarRowItems, type SideBarRowItem } from "../sidebar/side-bar-cluster-row.js";
import { sortCommanderRows, useSortPreference } from "./commander-sort.js";

/** 데스크톱과 폰의 지휘관 명단 — 뿌리 없는 시작 전·완료 줄도 같은 정렬과 그룹 규칙을 지난다. */
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
  const groups = [...state.groups].filter((group) => group.commodoreId === commodoreId).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  const groupIdOf = (item: SideBarRowItem) => item.anchor ? item.anchor.objectiveRecord.groupId ?? null : item.row.groupId;
  const groupIds = new Set(groups.map((group) => group.id));
  const sections = preference.grouped
    ? [...groups.map((group) => ({ id: group.id, title: group.name, rows: sorted.filter((item) => groupIdOf(item) === group.id) })),
      { id: "ungrouped", title: t("commanderTab.ungrouped"), rows: sorted.filter((item) => !groupIds.has(groupIdOf(item) ?? "")) }].filter((group) => group.rows.length > 0)
    : [{ id: "all", title: null, rows: sorted }];
  return { sorted, sections, preference };
}
