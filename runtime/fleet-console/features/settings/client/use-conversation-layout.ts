import { getViewModeSnapshot, subscribeViewMode, useViewMode } from "../../../core/client/src/integration/view-mode-store.js";

/** 데스크톱 Operations 화면은 대화 중심 배치다. 모바일은 자기 셸을 쓴다. */
export function useConversationLayout(): boolean {
  return useViewMode().effective === "desktop";
}

/** React 밖(플러그인 능력)에서 읽는 같은 판정. */
export function isConversationLayoutActive(): boolean {
  return getViewModeSnapshot().effective === "desktop";
}

export function subscribeConversationLayout(listener: () => void): () => void {
  return subscribeViewMode(listener);
}
