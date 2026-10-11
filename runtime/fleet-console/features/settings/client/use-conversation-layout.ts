import { getViewModeSnapshot, subscribeViewMode, useViewMode } from "../../../core/client/src/integration/view-mode-store.js";
import { getGlobalSettingsStoreState, setGlobalSettingsField, subscribe as subscribeGlobalSettings, useGlobalSettingsStore } from "./global-settings-store.js";

/** 데스크톱에서만 쓰는 배치 선택. 기본은 대화 중심 화면이라, 아직 읽지 못한 설정도 대화 중심으로 판정한다 — 첫 화면이 이전 배치로 번쩍이지 않는다. */
export function useConversationLayout(): boolean {
  const { state } = useGlobalSettingsStore();
  const { effective } = useViewMode();
  return effective === "desktop" && state?.experiments.classicLayout !== true;
}

/** React 밖(플러그인 능력)에서 읽는 같은 판정. */
export function isConversationLayoutActive(): boolean {
  return getViewModeSnapshot().effective === "desktop" && getGlobalSettingsStoreState().state?.experiments.classicLayout !== true;
}

export function subscribeConversationLayout(listener: () => void): () => void {
  const disposeViewMode = subscribeViewMode(listener);
  const disposeSettings = subscribeGlobalSettings(listener);
  return () => {
    disposeViewMode();
    disposeSettings();
  };
}

/** 「이전 화면으로 돌아가기」를 저장한다 — 설정 화면 밖(웰컴 카드·되돌리기 알림)에서 같은 실험 객체를 고쳐 쓴다. */
export function saveClassicLayout(classicLayout: boolean): Promise<boolean> {
  const experiments = getGlobalSettingsStoreState().state?.experiments;
  if (!experiments) return Promise.resolve(false);
  return setGlobalSettingsField("experiments", { ...experiments, classicLayout });
}
