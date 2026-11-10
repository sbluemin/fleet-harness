import type { Objective } from "../shared/types.js";
import { openFollowups, readBatches, readHistory, readOrigin } from "./followups.js";
import type { DetailTab } from "./objectives-panel.js";

/**
 * 행 글리프가 그 칸에 보여 줄 것이 있는가.
 * 목표: 브리핑 글·이미지·출처·합친 목표·달성 기준(제안 포함)·결정·회고·후속 목표·이전 회차. 구성원: 시작 전(세션 없음·미시작)이고 구성원이 없으면 비어 있다.
 * 증거: 증거·공유 폴더 파일. sharedFiles 가 null(모름)이면 비었다고 단정하지 않는다.
 */
export function briefHasContent(objective: Objective): boolean {
  return objective.note.trim() !== "" || objective.attachments.length > 0 || readOrigin(objective) !== null || objective.merged.length > 0;
}

export function objectiveTabHasContent(objective: Objective, tab: DetailTab | "results", sharedFiles: number | null): boolean {
  // 사이드바 「시작 전」과 같다 — 세션 레코드가 없고 지휘관이 시작하지 않았다. 구성원이 있으면 그 칸은 있다.
  if (tab === "crew") return objective.members.length > 0 || objective.commander.started || objective.hasSession === true;
  if (tab === "goal") {
    if (briefHasContent(objective) || objective.criteria.length > 0 || objective.criteriaProposals.length > 0 || objective.decisions.length > 0) return true;
    return objective.handoff !== null ||objective.extensions.length > 0 || readBatches(objective).length > 0 || readHistory(objective) !== null || openFollowups(objective).length > 0;
  }
  if (objective.results.length > 0) return true;
  return sharedFiles === null || sharedFiles > 0;
}
