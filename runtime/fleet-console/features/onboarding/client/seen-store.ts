import { getGlobalSettingsStoreState, isSavingGlobalSettingsField, setGlobalSettingsField } from "../../settings/client/global-settings-store.js";

/**
 * 본 기록 — 사용자 설정 seenFeatureTours 한 필드에 키로 쌓인다.
 *
 * 피처 투어·힌트 엔진은 제거됐고, 이 모듈은 첫 실행 안내가 쓰는 키만 남긴다.
 */

const SEEN_LIMIT = 64;

/**
 * 강도 확인 팁의 기록 키 — 투어 카탈로그 항목은 아니지만 같은 seenFeatureTours 필드에 실렸다. 팁을 띄우던 '+' 모델 메뉴는 새 세션
 * 화면으로 바뀌어 떠났지만, 이미 저장된 기록은 그대로 둔다.
 */
export const EFFORT_CONFIRM_TIP_SEEN_KEY = "effort-confirm-tip";

/**
 * 도움말 › 플릿 한눈에 보기의 본 기록 키 — 첫 실행에 한 번 자동으로 열리는 팝업이다.
 * 한 번 배포한 키는 바꾸지 않는다. 바꾸면 이미 본 사람에게 같은 안내가 다시 선다.
 */
export const FLEET_AT_A_GLANCE_SEEN_KEY = "fleet-at-a-glance";

/**
 * 태스크포스 소개 카드의 본 기록 키 — 실험 기능을 켜지 않은 기존 사용자에게 데스크톱 콘솔 시작 시 한 번 뜨는 팝업이다.
 * 한 번 배포한 키는 바꾸지 않는다. 바꾸면 이미 본 사람에게 같은 안내가 다시 선다.
 */
export const TASKFORCE_INTRO_SEEN_KEY = "taskforce-intro";

/**
 * 퀘이커 부관단 사령관 진급 카드의 본 기록 키 — 데스크톱 콘솔 시작 시 한 번 뜬다.
 * 한 번 배포한 키는 바꾸지 않는다. 바꾸면 이미 본 사람에게 같은 안내가 다시 선다.
 */
export const QUAKER_PROMOTION_SEEN_KEY = "quaker-promotion";

export function appendSeen(seen: readonly string[], key: string): readonly string[] {
  return seen.includes(key) ? seen : [...seen, key].slice(-SEEN_LIMIT);
}

export function appendSeenAll(seen: readonly string[], keys: readonly string[]): readonly string[] {
  return keys.reduce((next, key) => appendSeen(next, key), seen);
}

/**
 * 1회성 안내가 본 기록을 남긴다. 같은 seenFeatureTours 필드를 쓰는 저장이 겹칠 수 있으므로,
 * 인플라이트 저장이 끝난 틱에만 최신 값 위에 덧붙인다 — 같은 필드의 동시 저장은 뒤쪽이 밀려 기록이 유실된다.
 */
export function rememberSeen(keys: readonly string[]): void {
  if (keys.length === 0) return;
  void (async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const base = getGlobalSettingsStoreState().state?.seenFeatureTours ?? [];
      const next = appendSeenAll(base, keys);
      if (next === base) return;
      if (!isSavingGlobalSettingsField("seenFeatureTours") && await setGlobalSettingsField("seenFeatureTours", next)) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  })();
}
