import type { ClusterIndex, ClusterLayout } from "../objective-clusters.js";
import type { SideBarChipCluster, SideBarEntry } from "./objective-records-side-bar-chip.js";

/**
 * 사이드바의 묶음. 묶음은 뿌리(지휘관) 한 행이 대표한다.
 * 구성원은 스토어의 기본 목록에서 이미 빠지고(SDK `isListedObjective`),
 * 단계 표기는 상태 줄 앞에 `✓ N/N` 으로 선다 — 목표 줄(`side-bar-cluster-row-lead`)과 같은 글·같은 톤이다.
 * 활동(실행·대기·유휴·끝남)으로 색을 나누지 않는다.
 */
export function clusterChipPropsFor(entry: SideBarEntry, index: ClusterIndex): SideBarChipCluster | null {
  const root = index.rootOf.get(entry.objectiveRecord.id);
  if (!root) return null;
  const progressLabel = progressLabelOf(root);
  return {
    strip: progressLabel ? <span className="side-bar-cluster-row-lead">{progressLabel}</span> : null,
    ...(progressLabel ? { progressLabel } : {}),
    decisionRequest: root.cluster.decisionRequest === true,
    awaitingReview: root.cluster.row?.glyph === "review",
  };
}

/**
 * 단계 수. 목표 줄과 같은 `row.progress`(플러그인이 센 목표 임무 수)를 먼저 쓴다.
 * 끝난 목표는 줄을 내지 않으므로(`rowOf` 가 null) progress 가 없다. 그때는 임무 번호가 있는 구성원을 센다 —
 * 그 구성원은 목표 임무와 1:1 이고, `progress === "done"` 은 임무의 `done` 과 같다(`progressOf`).
 * 임무를 맡지 않은 구성원(번호 없음)은 어느 쪽 셈에도 들지 않는다. 임무가 없으면 단계를 적지 않는다.
 */
function progressLabelOf(layout: ClusterLayout): string | null {
  const fromRow = layout.cluster.row?.progress;
  const progress = fromRow && fromRow.total > 0
    ? fromRow
    : missionProgress(layout);
  if (!progress || progress.total <= 0) return null;
  return `✓ ${progress.done}/${progress.total}`;
}

function missionProgress(layout: ClusterLayout): { readonly done: number; readonly total: number } | null {
  const missions = layout.members.filter(({ member }) => member.missionNumber !== undefined);
  if (missions.length === 0) return null;
  return { done: missions.filter(({ member }) => member.progress === "done").length, total: missions.length };
}
