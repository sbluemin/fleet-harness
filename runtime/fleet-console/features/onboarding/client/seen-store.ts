import type { OnboardingContribution } from "../shared/types.js";

import { getGlobalSettingsStoreState, isSavingGlobalSettingsField, setGlobalSettingsField } from "../../settings/client/global-settings-store.js";

/**
 * 온보딩 본 기록 — 사용자 설정 seenFeatureTours 한 필드에 키로 쌓인다.
 *
 * 키는 기여에서 파생되며 한 번 배포한 키는 바꾸지 않는다. 바꾸면 이미 본 사람에게 같은 안내가 다시 선다.
 */
export type TourPhase = "spotlight" | "walkthrough";

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

export function hintSeenKey(contribution: OnboardingContribution): string | null {
  if (!contribution.entryHint) return null;
  return contribution.entryHint.seenKey ?? `${contribution.id}.rail-hint`;
}

export function tourSeenKey(tourId: string, phase: TourPhase): string {
  return `${tourId}.${phase}`;
}

export function appendSeen(seen: readonly string[], key: string): readonly string[] {
  return seen.includes(key) ? seen : [...seen, key].slice(-SEEN_LIMIT);
}

export function appendSeenAll(seen: readonly string[], keys: readonly string[]): readonly string[] {
  return keys.reduce((next, key) => appendSeen(next, key), seen);
}

/**
 * 투어 밖의 1회성 안내(힌트)가 본 기록을 남긴다. 닫는 즉시 뒤따르는 투어가 같은 필드를 저장할 수 있으므로,
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

export async function persistSeen(
  seen: readonly string[],
  key: string,
  persist: (next: readonly string[]) => Promise<boolean>,
): Promise<readonly string[]> {
  const next = appendSeen(seen, key);
  if (next === seen) return seen;
  await persist(next);
  return next;
}
