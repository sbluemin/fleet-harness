import { closeNewSession, getState, requestObjectiveKeyboardFocus, revealObjectiveStage, selectNestedBody, setActiveObjective } from "../../../../core/client/src/integration/store.js";
import { closeConversationSurface } from "../conversation/conversation-surface-store.js";
import { openFreshConversation } from "../../../objectives/client/fresh-conversation.js";
import { openLedger } from "../../../execution/client/agent/chat/group/index.js";

/**
 * 좌측 사이드바 지휘관 목록에서 고른 지휘관 — 레일이 작업 탭에 머물지 않고 예전 규칙(열려 있던 패널을 목표 보드로)을 따르게 한다.
 * 우측 작업 탭 목록 등 다른 길로 열면 비운다. 가운데 대상이 바뀌어 레일 규칙이 한 번 돌면 걷힌다.
 */
let sideBarPick: string | null = null;

export function readCommanderSideBarPick(): string | null {
  return sideBarPick;
}

export function clearCommanderSideBarPick(): void {
  sideBarPick = null;
}

/** 목록의 선택은 실행 재개가 아니라 그룹 대화 탐색이다. 시작 전·보관 목표는 기존 시작 화면으로 간다. */
export function openCommanderConversation(commodoreId: string, objectiveId: string, options?: { readonly fromSideBar?: boolean }): void {
  sideBarPick = options?.fromSideBar === true ? objectiveId : null;
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
