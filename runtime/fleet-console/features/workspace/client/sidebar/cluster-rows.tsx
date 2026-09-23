import type { Translate } from "@fleet-console/sdk/i18n";

import type { CoreMessageKey } from "../../../../core/client/src/i18n/index.js";
import { ClusterStrip } from "../cluster-strip.js";
import { isClusterCollapsed, nestClusterMembers, toggleClusterCollapsed, type ClusterFold, type ClusterIndex } from "../operation-clusters.js";
import type { SideBarChipCluster, SideBarEntry } from "./operations-side-bar-chip.js";

/**
 * 사이드바의 묶음 행 — Cruise·Tactical 의 Theater 목록과 War Room 의 선별 목록이 같은 문법을 쓴다.
 * 뿌리 뒤에 구성원이 위상 순으로 서고(섹션 entries 자체를 바꿔 드롭 인덱스와 DOM 이 어긋나지 않게), 접힌 묶음은 뿌리만 남는다.
 */
export function nestSectionEntries(entries: readonly SideBarEntry[], index: ClusterIndex, fold: ClusterFold): SideBarEntry[] {
  return [...nestClusterMembers(entries, (entry) => entry.operation.id, index)].filter((entry) => {
    const member = index.memberOf.get(entry.operation.id);
    return !member || !isClusterCollapsed(fold, member.layout.cluster.id) || !entries.some((candidate) => candidate.operation.id === member.layout.cluster.root);
  });
}

export function clusterChipPropsFor(entry: SideBarEntry, index: ClusterIndex, fold: ClusterFold, t: Translate<CoreMessageKey>, siblings?: readonly SideBarEntry[]): SideBarChipCluster | null {
  const root = index.rootOf.get(entry.operation.id);
  if (root) {
    const isCollapsed = isClusterCollapsed(fold, root.cluster.id);
    // 펼칠 것은 Operation 이 선 구성원뿐 — 자리표시(pending) 단계만 있으면 띠는 서되 접기 토글은 없다.
    return { role: "root", title: root.cluster.title, collapsed: isCollapsed, strip: <ClusterStrip layout={root} rootActivity={entry.status} onOpen={root.cluster.open} />, onToggle: () => toggleClusterCollapsed(root.cluster.id), expandable: root.formation.members.length > 0 };
  }
  const member = index.memberOf.get(entry.operation.id);
  if (!member) return null;
  const labels = member.laid.member.after.map((id) => member.layout.byOperationId.get(id)?.member.label.match(/^\d+/)?.[0] ?? null).filter((label): label is string => !!label);
  // 「마지막」은 묶음 전체가 아니라 지금 이 목록에 실제로 이어 서는 행 기준이다 — 다음 행이 같은 묶음이 아니면 여기서 줄기가 멎는다.
  const at = siblings ? siblings.findIndex((candidate) => candidate.operation.id === entry.operation.id) : -1;
  const next = at >= 0 ? siblings![at + 1] : undefined;
  const last = siblings ? !next || index.memberOf.get(next.operation.id)?.layout.cluster.id !== member.layout.cluster.id : member.laid.order === member.layout.formation.members.length - 1;
  return {
    role: "member",
    title: member.layout.cluster.title,
    label: member.laid.member.label,
    depth: member.laid.depth,
    last,
    progress: member.laid.member.progress,
    afterTag: labels.length > 1 ? t("cluster.after", { steps: labels.join("·") }) : null,
  };
}
