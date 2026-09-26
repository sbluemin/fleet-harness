import type { OnboardingContribution } from "@fleet-console/sdk/onboarding";

import { getGlobalSettingsStoreState, isSavingGlobalSettingsField, setGlobalSettingsField } from "../../settings/client/global-settings-store.js";

/**
 * 온보딩 본 기록 — 사용자 설정 seenFeatureTours 한 필드에 키로 쌓인다.
 *
 * 키는 기여에서 파생되며 한 번 배포한 키는 바꾸지 않는다. 바꾸면 이미 본 사람에게 같은 안내가 다시 선다.
 */
export type TourPhase = "spotlight" | "walkthrough";

const SEEN_LIMIT = 64;

export function welcomeSeenKey(contribution: OnboardingContribution): string | null {
  if (!contribution.welcome) return null;
  return contribution.welcome.seenKey ?? `${contribution.id}.welcome`;
}

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
 * 투어 밖의 1회성 안내(웰컴·힌트)가 본 기록을 남긴다. 닫는 즉시 뒤따르는 투어가 같은 필드를 저장할 수 있으므로,
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

// "화면 안내 다시 보기"가 되돌릴 대상 — 호스트가 마운트한 기여 목록. 호스트는 코어 번들에 한 번만 마운트되므로
// 이 모듈 상태는 그 번들 안에서만 읽힌다(플러그인 번들은 기여를 넘길 뿐 이 상태를 읽지 않는다).
let mountedContributions: readonly OnboardingContribution[] = [];

export function setMountedOnboardingContributions(contributions: readonly OnboardingContribution[]): void {
  mountedContributions = contributions;
}

/**
 * 다시 보기 — 힌트와 투어의 본 기록을 지운다. 웰컴은 되돌리지 않는다: 웰컴은 "이번 업데이트로 새로 생긴 것"이라는
 * 한 번의 사건이고, 그 사건은 다시 일어나지 않는다.
 */
export function forgetReplayableOnboarding(seen: readonly string[]): readonly string[] {
  const drop = new Set<string>();
  for (const contribution of mountedContributions) {
    const hint = hintSeenKey(contribution);
    if (hint) drop.add(hint);
    for (const tour of contribution.tours ?? []) {
      drop.add(tourSeenKey(tour.id, "walkthrough"));
      drop.add(tourSeenKey(tour.id, "spotlight"));
    }
  }
  const next = seen.filter((key) => !drop.has(key));
  return next.length === seen.length ? seen : next;
}
