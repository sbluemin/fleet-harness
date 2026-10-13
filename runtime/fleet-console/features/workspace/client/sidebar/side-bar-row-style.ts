import type { OperationMarkVisual } from "../../../execution/client/operation-activity.js";

/** 대화 목록 행의 둘째 줄 — 미리보기 필드가 오기 전까지 활동을 문장으로 말한다. */
export const CONVERSATION_ROW_PHRASE = {
  running: "conversation.row.running",
  awaiting: "conversation.row.awaiting",
  unseen: "conversation.row.unseen",
  idle: "conversation.row.idle",
  ended: "conversation.row.ended",
} as const satisfies Record<OperationMarkVisual, string>;

