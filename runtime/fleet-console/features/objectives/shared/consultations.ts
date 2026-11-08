/** 프롬프트 자문을 거친 확정 문구. 후보 문구로 되돌리지 않는다. */

export const CONSULT_ASK_DESCRIPTION = "Ask your Commodore for context or a second opinion to inform your judgment, not approval or work delegation. Returns an id; replies arrive asynchronously and are recorded on the objective board. Consultations do not hold the objective or change requirements, permissions, decision requests, or existing holds. Use decision_request for decisions outside your authority.";

export const CONSULT_ANSWER_DESCRIPTION = "Reply with context or advice for the Commander's judgment, or omit answer for \"No additional advice.\" Distinguish your opinion from existing requirements; cite the original source of any person's requirement you relay. This reply grants no approval, delegates no work, and changes no requirements, permissions, decision requests, or holds.";

export const CONSULT_ANSWER_OMIT = "Reply with context or advice for the Commander's judgment, or omit answer for \"No additional advice.\"";

export const CONSULT_ANSWER_SOURCE = "Distinguish your opinion from existing requirements; cite the original source of any person's requirement you relay.";

/** 답 알림. 본문을 싣지 않는다 — 보드에 둔 답을 매 턴 요구처럼 다시 넣지 않기 위해서다. */
export function consultationNotice(kind: "advice" | "no-additional-advice", consultId: string): string {
  return kind === "no-additional-advice"
    ? `Consultation ${consultId}: No additional advice. Decision requests and holds are unchanged.`
    : `Your Commodore replied to consultation ${consultId}. Read the question, reply, and cited sources in objective_read. Decision requests and holds are unchanged.`;
}
