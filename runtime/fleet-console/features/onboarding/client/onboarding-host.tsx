import { useCallback, useEffect, useMemo } from "react";

import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import type { OnboardingContribution } from "@fleet-console/sdk/onboarding";

import { useGlobalSettingsStore } from "../../settings/client/global-settings-store.js";
import { EntryHints, findShowableHint, type EntryHintCandidate, type EntryHintPorts } from "./entry-hint.js";
import { hintSeenKey, rememberSeen, setMountedOnboardingContributions, welcomeSeenKey } from "./seen-store.js";
import { TourOverlay } from "./tour-overlay.js";
import { WelcomeDeck, type WelcomeCandidate } from "./welcome-deck.js";
import "./onboarding.css";

export interface OnboardingHostProps {
  /** Console 코어 기능의 기여 — 각 단계에서 먼저 선다. */
  readonly core: readonly OnboardingContribution[];
  /** SDK 계약으로 들어온 플러그인 기여 — 같은 단계에서 코어 다음에 선다. */
  readonly plugins: readonly OnboardingContribution[];
  readonly language: ConsoleLocale;
  readonly whatsNewOpen: boolean;
  /**
   * 처음 설치한 사용자인가(Theater도 첫 실행 안내 기록도 없다). 이들에게는 지금 있는 기능 전부가 처음이라 웰컴의
   * "새로 생겼다"가 성립하지 않는다 — 현재 슬라이드를 본 것으로 적어 두어, 다음 업데이트부터 새 기능만 알린다.
   */
  readonly firstRun: boolean;
  readonly ports: EntryHintPorts;
}

/**
 * 온보딩 엔진 — 내용을 모른 채 순서만 소유한다: 웰컴 → 엔트리 힌트 → 투어, 각 단계 안에서는 코어 기여가 먼저다.
 *
 * - 웰컴은 aria-modal 카드라 떠 있는 동안 힌트와 투어가 물러난다.
 * - 가리킬 힌트가 남아 있는 동안 투어는 새로 시작하지 않는다(재생 중인 투어는 끊지 않는다).
 */
export function OnboardingHost({ core, plugins, language, whatsNewOpen, firstRun, ports }: OnboardingHostProps) {
  const settings = useGlobalSettingsStore();
  const seen = settings.state?.seenFeatureTours ?? null;
  const contributions = useMemo(() => [...core, ...plugins], [core, plugins]);
  useEffect(() => { setMountedOnboardingContributions(contributions); }, [contributions]);

  const welcomes = useMemo<readonly WelcomeCandidate[]>(() => contributions.flatMap((contribution) => {
    const key = welcomeSeenKey(contribution);
    return key && contribution.welcome ? [{ seenKey: key, slide: contribution.welcome }] : [];
  }), [contributions]);
  const hints = useMemo<readonly EntryHintCandidate[]>(() => contributions.flatMap((contribution) => {
    const key = hintSeenKey(contribution);
    return key && contribution.entryHint ? [{ seenKey: key, hint: contribution.entryHint }] : [];
  }), [contributions]);
  const tours = useMemo(() => contributions.flatMap((contribution) => contribution.tours ?? []), [contributions]);

  // 처음 온 사람의 웰컴은 본 것으로 적는다. 첫 실행이 끝나기 전(Theater 등록·첫 실행 안내 종료)까지 늦게 로드된
  // 플러그인의 슬라이드도 같은 창에서 적히도록, 슬라이드 목록이 바뀔 때마다 다시 잰다.
  useEffect(() => {
    if (!firstRun || !seen) return;
    const unseen = welcomes.map((candidate) => candidate.seenKey).filter((key) => !seen.includes(key));
    if (unseen.length > 0) rememberSeen(unseen);
  }, [firstRun, seen, welcomes]);

  // 가리킬 힌트가 남았는가를 투어가 시작을 판정하는 바로 그 순간에 잰다. 힌트 표면의 폴링 상태를 빌려 쓰면 본 기록이
  // 바뀐 틱(예: 화면 안내 다시 보기)에 투어가 먼저 판정되어 순서가 뒤집힌다.
  const toursBlocked = useCallback(
    () => seen !== null && findShowableHint(hints, seen, ports) !== null,
    [hints, ports, seen],
  );

  return (
    <>
      <WelcomeDeck candidates={welcomes} whatsNewOpen={whatsNewOpen} seen={seen} language={language} />
      <EntryHints candidates={hints} seen={seen} language={language} ports={ports} />
      <TourOverlay tours={tours} language={language} blocked={toursBlocked} />
    </>
  );
}

export { forgetReplayableOnboarding } from "./seen-store.js";
