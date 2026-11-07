import { closeNewSession, getState, requestObjectiveKeyboardFocus, revealObjectiveStage, selectNestedBody, setActiveObjective } from "../../../../core/client/src/integration/store.js";
import { closeConversationSurface } from "../conversation/conversation-surface-store.js";
import { openFreshConversation } from "../../../objectives/client/fresh-conversation.js";
import { openLedger } from "../../../execution/client/agent/chat/group/index.js";

/** 목록의 선택은 실행 재개가 아니라 그룹 대화 탐색이다. 시작 전·보관 목표는 기존 시작 화면으로 간다. */
export function openCommanderConversation(commodoreId: string, objectiveId: string): void {
  closeNewSession();
  const record = getState().objectiveRecords.find((item) => item.id === objectiveId && item.commodoreId === commodoreId);
  if (!record) { openFreshConversation(objectiveId); return; }
  revealObjectiveStage();
  closeConversationSurface();
  selectNestedBody(objectiveId, null);
  openLedger(objectiveId, null);
  setActiveObjective(objectiveId);
  requestObjectiveKeyboardFocus(objectiveId);
}
