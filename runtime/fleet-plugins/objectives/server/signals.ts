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

/**
 * 임무 행의 발주·수신 흔적 — 담당 구성원에게 지휘관의 세션 간 메시지가 닿은 시각과 그 뒤 구성원이 일을 집어 든 시각. 배정 뒤에 닿은 발주만
 * 그 임무의 것이다(무보고 계산과 같은 배정 시각 기준). 본문은 어디에도 남기지 않는다. 발주가 없거나 배정 전이면 null.
 */
export function missionDispatch(assignmentTs: number | undefined, member: { readonly dispatchedAt?: number; readonly receivedAt?: number } | undefined): { readonly at: number; readonly receivedAt: number | null } | null {
  const at = member?.dispatchedAt;
  if (typeof at !== "number" || !Number.isFinite(at) || at < (assignmentTs ?? 0)) return null;
  const received = member?.receivedAt;
  return { at, receivedAt: typeof received === "number" && Number.isFinite(received) && received >= at ? received : null };
}

/** 실패 턴의 사유 — 사용 한도 소진, 또는 그 밖의 공급자 요청 제한. */
export type MemberFailureReason = "limit_exhausted" | "rate_limited";

/**
 * 실패로 닫힌 구성원 턴의 사유. 그 턴을 닫은 에이전트 CLI 가 스스로 붙인 코드만 읽는다. Claude Code 는 턴을 닫는 429 를 모두 `error`
 * `rate_limit` 으로 표시하므로(Chat 은 assistant 의 `error`, PTY 는 StopFailure 의 `error`) 그것만으로는 「요청 제한」까지만 말한다. 사용 한도
 * 소진은 CLI 가 원인 종류로 `api_error: usage_limit_reached` 를 붙였을 때만이다 — 일시적 용량 제한(「not your usage limit」)·1M 크레딧 부족도
 * 같은 `rate_limit` 으로 오기 때문이다. 원문 문장과 Gateway 한도 창은 판정에 쓰지 않는다: 문장은 한도를 말한 정상 응답과 섞이고, 한도 창
 * 100% 는 그 구성원이 정상으로 도는 동안에도 선다. 화면 표시·목록 표식·지휘관 통지가 이 판정 하나를 쓴다.
 */
export function memberFailureReason(failure: { readonly error: string; readonly api_error?: string }): MemberFailureReason | null {
  if (failure.api_error === "usage_limit_reached") return "limit_exhausted";
  return failure.error === "rate_limit" ? "rate_limited" : null;
}

/** 무보고 사실 한 줄. 화면 뱃지와 지휘관 깨움이 이 문장만 쓴다. */
export function describeQuietMission(minutes: number, language: "en" | "ko"): string {
  const n = Math.max(0, Math.floor(minutes));
  return language === "ko" ? `배정 후 보고 없이 ${n}분` : `No report for ${n} min since assignment`;
}


/**
 * 보고를 기대하는가 — 기대가 없으면 경보(무보고 깨움·무보고 정지 통지)도 없다. stop 은 그 뒤로 보고가 오지 않는 것이 정상인 조건을 만들므로,
 * 마지막 stop 이 이 침묵의 시작(배정·보드 변경) 이후면 새 경보를 보내지 않는다. 표시(뱃지)와 이미 남은 기록은 그대로 둔다.
 * 기대를 다시 만드는 것은 그 목표에 지시를 보내는 행위다 — 누가 하든(사람·사령관·지휘관) 같다. launch.ts 에서 stop 기록을 거두는 자리:
 * 개시(start), 구상 요청(requestPlan — 확장도 이 길), 스티어(steer), 메시지(message, 지휘관·구성원 모두), 결정 답 전달(decisionAnswer).
 * stop 뒤의 새 배정이나 보드 변경은 침묵의 시작을 stop 뒤로 옮기므로 그 임무의 기대도 되살아난다.
 */
export function expectsReport(stoppedAt: number | null, since: number): boolean {
  return stoppedAt == null || since > stoppedAt;
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
