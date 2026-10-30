import { getState } from "../../../../../core/client/src/integration/store.js";

/**
 * `requestObjectiveKeyboardFocus` 한 번은 보이는 컴포저 하나만 소비한다.
 * 요청 id가 바뀌기 전에는 다시 포커스를 빼앗지 않는다.
 */
let claimedRequestId = 0;

export function claimComposerKeyboardFocus(objectiveId: string): boolean {
  const request = getState().keyboardFocusRequest;
  if (!request || request.objectiveId !== objectiveId || request.requestId === 0) return false;
  if (request.requestId === claimedRequestId) return false;
  claimedRequestId = request.requestId;
  return true;
}
