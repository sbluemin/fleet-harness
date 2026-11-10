import type { Objective } from "../shared/types.js";
import { openFollowups, readBatches, readHistory, readOrigin } from "./followups.js";
import type { DetailTab } from "./objectives-panel.js";

/**
 * 행 글리프가 그 칸에 보여 줄 것이 있는가.
 * 목표: 브리핑 글·이미지·출처·합친 목표·달성 기준(제안 포함)·결정·회고·후속 목표·이전 회차. 구성원: 지휘관 줄이 늘 서므로 언제나 있다.
 * 증거: 증거·공유 폴더 파일. sharedFiles 가 null(모름)이면 비었다고 단정하지 않는다.
 */
export function briefHasContent(objective: Objective): boolean {
  return objective.note.trim() !== "" || objective.attachments.length > 0 || readOrigin(objective) !== null || objective.merged.length > 0;
}

export function objectiveTabHasContent(objective: Objective, tab: DetailTab | "results", sharedFiles: number | null): boolean {
  if (tab === "crew") return true;
  if (tab === "goal") {
    if (briefHasContent(objective) || objective.criteria.length > 0 || objective.criteriaProposals.length > 0 || objective.decisions.length > 0) return true;
    return objective.handoff !== null ||objective.extensions.length > 0 || readBatches(objective).length > 0 || readHistory(objective) !== null || openFollowups(objective).length > 0;
  }
  if (objective.results.length > 0) return true;
  return sharedFiles === null || sharedFiles > 0;
}
