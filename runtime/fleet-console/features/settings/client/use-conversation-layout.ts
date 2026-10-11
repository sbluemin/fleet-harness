import { useViewMode } from "../../../core/client/src/integration/view-mode-store.js";
import { useGlobalSettingsStore } from "./global-settings-store.js";

/** 데스크톱에서만 쓰는 배치 선택. 아직 읽지 못한 설정은 기존 배치를 유지한다. */
export function useConversationLayout(): boolean {
  const { state } = useGlobalSettingsStore();
  const { effective } = useViewMode();
  return effective === "desktop" && state?.experiments.conversationLayout === true;
}
