import { ClusterStrip } from "../cluster-strip.js";
import type { ClusterIndex } from "../operation-clusters.js";
import type { SideBarChipCluster, SideBarEntry } from "./operations-side-bar-chip.js";

/**
 * 사이드바의 묶음 — Cruise·Tactical 의 Theater 목록과 War Room 의 선별 목록이 같은 문법을 쓴다.
 * 묶음은 뿌리(셰프) 한 행이 대표하고, 단계 Operation 은 사이드바에 서지 않는다(Cruise 캔버스의 대형은 그대로).
 * 섹션 entries 자체에서 빼서 드롭 인덱스와 DOM 이 어긋나지 않게 한다. 뿌리가 목록에 없으면 구성원은 평범한 행으로 남는다.
 */
export function withoutClusterMembers(entries: readonly SideBarEntry[], index: ClusterIndex, roots: readonly SideBarEntry[] = entries): SideBarEntry[] {
  if (index.memberOf.size === 0) return [...entries];
  const present = new Set(roots.map((entry) => entry.operation.id));
  return entries.filter((entry) => {
    const member = index.memberOf.get(entry.operation.id);
    return !member || !present.has(member.layout.cluster.root);
  });
}

export function clusterChipPropsFor(entry: SideBarEntry, index: ClusterIndex): SideBarChipCluster | null {
  const root = index.rootOf.get(entry.operation.id);
  if (!root) return null;
  return { strip: <ClusterStrip layout={root} rootActivity={entry.status} onOpen={root.cluster.open} /> };
}
