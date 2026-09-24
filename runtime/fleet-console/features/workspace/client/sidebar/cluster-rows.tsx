import { ClusterStrip } from "../cluster-strip.js";
import type { ClusterIndex } from "../operation-clusters.js";
import type { SideBarChipCluster, SideBarEntry } from "./operations-side-bar-chip.js";

/**
 * 사이드바의 묶음 — Cruise·Tactical 의 Theater 목록과 War Room 의 선별 목록이 같은 문법을 쓴다.
 * 묶음은 뿌리(지휘관) 한 행이 대표한다. 구성원은 스토어의 기본 목록에서 이미 빠지고(SDK `isListedOperation`),
 * 단계 띠는 그 행의 셋째 줄(이름 · 위치 · 띠)에 선다.
 */
export function clusterChipPropsFor(entry: SideBarEntry, index: ClusterIndex): SideBarChipCluster | null {
  const root = index.rootOf.get(entry.operation.id);
  if (!root) return null;
  return { strip: <ClusterStrip layout={root} rootActivity={entry.status} onOpen={root.cluster.open} className="side-bar-chip-cluster-strip" /> };
}
