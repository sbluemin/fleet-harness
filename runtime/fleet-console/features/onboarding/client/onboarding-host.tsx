import { useCallback, useEffect, useMemo } from "react";

import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import type { OnboardingContribution } from "@fleet-console/sdk/onboarding";

import { useGlobalSettingsStore } from "../../settings/client/global-settings-store.js";
import { EntryHints, hasPendingHint, type EntryHintCandidate, type EntryHintPorts } from "./entry-hint.js";
import { hintSeenKey, setMountedOnboardingContributions } from "./seen-store.js";
import { TourOverlay } from "./tour-overlay.js";
import "./onboarding.css";

export interface OnboardingHostProps {
  /** Console 코어 기능의 기여 — 각 단계에서 먼저 선다. */
  readonly core: readonly OnboardingContribution[];
  /** SDK 계약으로 들어온 플러그인 기여 — 같은 단계에서 코어 다음에 선다. */
  readonly plugins: readonly OnboardingContribution[];
  readonly language: ConsoleLocale;
  readonly ports: EntryHintPorts;
  /** 호스트의 전환 장면 중에는 투어를 시작하거나 표시하지 않고 진행 위치만 보존한다. */
  readonly toursSuspended?: boolean;
}

/**
 * 온보딩 엔진 — 내용을 모른 채 순서만 소유한다: 엔트리 힌트 → 투어, 각 단계 안에서는 코어 기여가 먼저다.
 *
 * - 가리킬 힌트가 남아 있는 동안 투어는 새로 시작하지 않는다(재생 중인 투어는 끊지 않는다).
 */
export function OnboardingHost({ core, plugins, language, ports, toursSuspended = false }: OnboardingHostProps) {
  const settings = useGlobalSettingsStore();
  const seen = settings.state?.seenFeatureTours ?? null;
  const contributions = useMemo(() => [...core, ...plugins], [core, plugins]);
  useEffect(() => { setMountedOnboardingContributions(contributions); }, [contributions]);

  const hints = useMemo<readonly EntryHintCandidate[]>(() => contributions.flatMap((contribution) => {
    const key = hintSeenKey(contribution);
    return key && contribution.entryHint ? [{ seenKey: key, hint: contribution.entryHint }] : [];
  }), [contributions]);
  const tours = useMemo(() => contributions.flatMap((contribution) => contribution.tours ?? []), [contributions]);

  // 가리킬 힌트가 남았는가를 투어가 시작을 판정하는 바로 그 순간에 잰다. 힌트 표면의 폴링 상태를 빌려 쓰면 본 기록이
  // 바뀐 틱(예: 화면 안내 다시 보기)에 투어가 먼저 판정되어 순서가 뒤집힌다. 문이 아직 잠긴 힌트도 남은 것으로 친다.
  const toursBlocked = useCallback(
    () => seen !== null && hasPendingHint(hints, seen, ports),
    [hints, ports, seen],
  );

  return (
    <>
      <EntryHints candidates={hints} seen={seen} language={language} ports={ports} held={toursSuspended} />
      <TourOverlay tours={tours} language={language} blocked={toursBlocked} suspended={toursSuspended} />
    </>
  );
}

export { forgetReplayableOnboarding } from "./seen-store.js";
