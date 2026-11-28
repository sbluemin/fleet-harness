import { useSyncExternalStore } from "react";

import { getGlobalSettingsStoreState, subscribe as subscribeGlobalSettings } from "../../../settings/client/global-settings-store.js";

/**
 * 목표 보드(지휘판) 실험 게이트 — 설정 › 실험의 「목표 보드」가 켜져 있을 때만 보드로 가는 길이 열린다.
 *
 * 데스크톱(사이드바 행·⌘B·팔레트·레일 링크·소개 카드)과 모바일(홈 진입·사령관 화면 링크·복원 목적지)이
 * 모두 이 한 곳을 읽는다. 설정을 아직 읽지 못했으면 기본값(꺼짐)으로 다룬다.
 */
export function isCommandBoardEnabled(): boolean {
  return getGlobalSettingsStoreState().state?.experiments.commandBoard === true;
}

export function useCommandBoardEnabled(): boolean {
  return useSyncExternalStore(subscribeGlobalSettings, isCommandBoardEnabled, () => false);
}

export { subscribeGlobalSettings as subscribeCommandBoardEnabled };

/** 설정을 읽었는가 — 읽기 전의 꺼짐은 확정이 아니라서, 저장된 목적지를 지우는 판단은 읽은 뒤에만 한다. */
function isCommandBoardSettingKnown(): boolean {
  return getGlobalSettingsStoreState().state != null;
}

export function useCommandBoardSettingKnown(): boolean {
  return useSyncExternalStore(subscribeGlobalSettings, isCommandBoardSettingKnown, () => false);
}
