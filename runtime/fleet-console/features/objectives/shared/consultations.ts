/** 프롬프트 자문을 거친 확정 문구. 후보 문구로 되돌리지 않는다. */

export const CONSULT_ASK_DESCRIPTION = "Ask your Commodore for context, advice, or a decision beyond your authority. Returns an id; replies arrive asynchronously on the board. Decisions are recorded separately. Consultations do not hold the objective, grant approval, delegate work, or change requirements, permissions, or holds.";

export const CONSULT_ANSWER_DESCRIPTION = "Reply with context or advice for the Commander's judgment, or omit answer for \"No additional advice.\" Distinguish your opinion from existing requirements; cite the original source of any person's requirement you relay. This reply grants no approval, delegates no work, and changes no requirements, permissions, or holds; use decision_update for board decisions.";

export const CONSULT_ANSWER_OMIT = "Reply with context or advice for the Commander's judgment, or omit answer for \"No additional advice.\"";

export const CONSULT_ANSWER_SOURCE = "Distinguish your opinion from existing requirements; cite the original source of any person's requirement you relay.";

/** 답 알림. 본문을 싣지 않는다 — 보드에 둔 답을 매 턴 요구처럼 다시 넣지 않기 위해서다. */
/** 자문 답 알림. 추가 의견 없음은 그 자문 이후 보드 결정이 바뀐 경우에만 결정 읽기를 붙인다. */
export function consultationNotice(kind: "advice" | "no-additional-advice", consultId: string, decisionsUpdated = false): string {
  if (kind === "advice") return `Consultation ${consultId}: Read the reply, sources, and any updated decisions in objective_read.`;
  return decisionsUpdated
    ? `Consultation ${consultId}: No additional advice. Read updated decisions in objective_read.`
    : `Consultation ${consultId}: No additional advice.`;
}

/** 자문 회신 없이 기록한 보드 결정 — 지휘관이 objective_read 로 읽게 한다. */
export function decisionUpdateNotice(): string {
  return "Board decisions updated. Read updated decisions in objective_read.";
}

/** 이 자문 이후, 또는 이 자문에 묶여 보드 결정이 바뀌었는가. */
export function decisionsChangedForConsult(decisions: readonly { readonly consultId?: string; readonly at: number; readonly updatedAt?: number }[], consult: { readonly id: string; readonly at: number }): boolean {
  return decisions.some((decision) => decision.consultId === consult.id || (decision.updatedAt ?? decision.at) >= consult.at);
}
