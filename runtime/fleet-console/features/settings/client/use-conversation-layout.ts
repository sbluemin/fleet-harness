import { getViewModeSnapshot, subscribeViewMode, useViewMode } from "../../../core/client/src/integration/view-mode-store.js";
import { getGlobalSettingsStoreState, subscribe as subscribeGlobalSettings, useGlobalSettingsStore } from "./global-settings-store.js";

/** 데스크톱에서만 쓰는 배치 선택. 아직 읽지 못한 설정은 기존 배치를 유지한다. */
export function useConversationLayout(): boolean {
  const { state } = useGlobalSettingsStore();
  const { effective } = useViewMode();
  return effective === "desktop" && state?.experiments.conversationLayout === true;
}

/** React 밖(플러그인 능력)에서 읽는 같은 판정. */
export function isConversationLayoutActive(): boolean {
  return getViewModeSnapshot().effective === "desktop" && getGlobalSettingsStoreState().state?.experiments.conversationLayout === true;
}

export function subscribeConversationLayout(listener: () => void): () => void {
  const disposeViewMode = subscribeViewMode(listener);
  const disposeSettings = subscribeGlobalSettings(listener);
  return () => {
    disposeViewMode();
    disposeSettings();
  };
}
