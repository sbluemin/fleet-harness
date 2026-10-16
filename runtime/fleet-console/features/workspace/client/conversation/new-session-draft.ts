import { getState, subscribe } from "../../../../core/client/src/integration/store.js";

/**
 * 열린 새 세션 화면의 미발사 입력. 수명은 store 의 `newSession` 이 열려 있는 동안이다 — 화면 칸이 잠시 내려가도(다른 컴퓨터를
 * 보고 돌아오는 등) 같은 열린 새 세션으로 돌아오면 쓰던 문장이 그대로 선다. 새 세션이 닫히면(취소·Escape·Operation 포커스·
 * 거절 초안의 Quick Launch 반환) 함께 비운다. 메모리에만 두고 서버나 저장소로 보내지 않으며, 이 컴퓨터의 새 세션 화면만 읽는다.
 */
let draft = "";
let watching = false;

function watchLifetime(): void {
  if (watching) return;
  watching = true;
  // 닫힘은 여러 owner 가 만든다(store 의 closeNewSession·focusOperation·setActiveOperation). 그 결과인 상태 하나만 본다.
  subscribe(() => { if (getState().newSession === null) draft = ""; });
}

export function readNewSessionDraft(): string {
  return getState().newSession === null ? "" : draft;
}

export function writeNewSessionDraft(text: string): void {
  if (getState().newSession === null) return;
  watchLifetime();
  draft = text;
}

/** 실행 의도로 넘긴 문장은 더 이상 초안이 아니다 — 시작 중에 화면이 다시 서도 같은 문장을 또 보내지 않게 비운다. */
export function clearNewSessionDraft(): void {
  draft = "";
}
