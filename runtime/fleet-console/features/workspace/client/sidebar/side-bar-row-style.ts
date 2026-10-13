import { createContext, useContext } from "react";

import type { OperationMarkVisual } from "../../../execution/client/operation-activity.js";

/**
 * 사이드바 행의 문법. "canvas"는 지금의 칩(이름 + 위치 줄)이고, "conversation"은 대화 중심 화면의 대화 목록
 * 행(이름 아래 상태 문구 한 줄)이다. 셸이 사이드바를 감싸 정한다 — 행마다 prop 을 내리지 않는다.
 */
export type SideBarRowStyle = "canvas" | "conversation";

export const SideBarRowStyleContext = createContext<SideBarRowStyle>("canvas");

export function useSideBarRowStyle(): SideBarRowStyle {
  return useContext(SideBarRowStyleContext);
}

/** 대화 목록 행의 둘째 줄 — 미리보기 필드가 오기 전까지 활동을 문장으로 말한다. */
export const CONVERSATION_ROW_PHRASE = {
  running: "conversation.row.running",
  awaiting: "conversation.row.awaiting",
  unseen: "conversation.row.unseen",
  idle: "conversation.row.idle",
  ended: "conversation.row.ended",
} as const satisfies Record<OperationMarkVisual, string>;

