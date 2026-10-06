/**
 * 배정된 준비 임무의 무보고 간격 — 표시와 깨움이 같은 계산을 쓴다.
 * 마지막 보드 변경은 기록·결과·증거 쓰기를 포함한다. 그 시각이 배정보다 늦으면 침묵은 그때부터 다시 센다.
 */

export const DISPLAY_QUIET_MS = 15 * 60_000;
export const REPORT_QUIET_MS = 25 * 60_000;

/** 침묵이 시작된 시각 — 배정과 마지막 보드 변경 중 늦은 쪽. */
export function quietSince(assignmentTs: number, lastBoardChange: number): number {
  return Math.max(assignmentTs, lastBoardChange);
}

/** 무보고 사실 한 줄. 화면 뱃지와 지휘관 깨움이 이 문장만 쓴다. */
export function describeQuietMission(minutes: number, language: "en" | "ko"): string {
  const n = Math.max(0, Math.floor(minutes));
  return language === "ko" ? `배정 후 보고 없이 ${n}분` : `No report for ${n} min since assignment`;
}


/** 목표가 실제로 진행 중일 때만 무보고를 센다. 표시와 깨움이 같은 판정을 쓴다. */
export function objectiveUnderway(objective: { readonly commenced: boolean; readonly planning: boolean; readonly done: unknown; readonly removed: unknown }): boolean {
  return objective.commenced && !objective.planning && !objective.done && !objective.removed;
}

export function quietElapsed(input: {
  readonly ready: boolean;
  readonly assigned: boolean;
  readonly assignmentTs: number | null;
  readonly boardUpdatedAt: number | null;
  readonly decisionPending: boolean;
  readonly reviewPending: boolean;
  /** 개시됐고 구상 중이 아니며 완료·정리되지 않았다. 정지(stop)는 개시 전 구상을 끄므로 commenced 가 아니다. */
  readonly underway: boolean;
}, now: number): number | null {
  if (!input.underway || !input.ready || !input.assigned || input.assignmentTs == null || input.decisionPending || input.reviewPending) return null;
  const elapsed = now - quietSince(input.assignmentTs, input.boardUpdatedAt ?? input.assignmentTs);
  return elapsed < 0 ? 0 : elapsed;
}
