import type { ConsoleLocale, LocalizedText } from "@fleet-console/sdk/i18n";
import type { OnboardingContribution } from "@fleet-console/sdk/onboarding";

import { getT, type ObjectiveMessageKey } from "./i18n/index.js";

function T(key: ObjectiveMessageKey): LocalizedText {
  return (locale: ConsoleLocale) => getT(locale)(key);
}

// 목록은 Console 사이드바 그룹 트리에 산다. 표면의 투어는 아직 목표를 고르지 않은 빈 상태에서 짚는다.
const PICK = ".objectives-pick-pane";
const DETAIL = ".objectives-detail";

/**
 * Objectives 온보딩 — 레일 진입점 힌트, 빈 상태·상세 투어. 이 플러그인이 문구·앵커의 단일 원천이고,
 * 호스트는 Console 코어 기능의 온보딩 다음 순서로 보인다. 본 기록 키(objectives.rail-hint·
 * objectives.walkthrough·objectives-detail.walkthrough)는 한 번 배포하면 바꾸지 않는다.
 */
export const objectivesOnboarding: OnboardingContribution = {
  id: "objectives",
  entryHint: {
    railEntryId: "objectives",
    title: T("objectives.onboarding.hint.title"),
    body: T("objectives.onboarding.hint.body"),
    shortcutCommandId: "console.toggle-objectives",
  },
  tours: [
    {
      id: "objectives",
      // 사용자가 직접 연 순간이 안내가 닿는 때이므로 미루지 않는다.
      spotlight: null,
      walkthrough: [
        { anchor: `${PICK} [data-objectives-tour="pick"]`, title: T("objectives.onboarding.list.step1Title"), body: T("objectives.onboarding.list.step1Body") },
        // 사람의 입구는 호스트 사이드바 「+」의 새 Operation 이다 — 다른 번들의 DOM 이라 짚지 않고 말로만 안내한다.
        { anchor: null, title: T("objectives.onboarding.list.step2Title"), body: T("objectives.onboarding.list.step2Body"), example: T("objectives.onboarding.list.step2Example") },
        { anchor: `${PICK} [data-objectives-tour="place"]`, title: T("objectives.onboarding.list.step3Title"), body: T("objectives.onboarding.list.step3Body") },
      ],
    },
    {
      id: "objectives-detail",
      // 목표 하나를 처음 연 순간 — 그 목표의 구획을 화면 순서대로 짚는다. 구획은 모두 늘 렌더되므로 목표 상태와 무관하게
      // 다섯 스텝이 선다. 목록이 DOM에 남아 있는 한 미루면 영영 뜨지 않으므로 미루지 않는다.
      spotlight: null,
      walkthrough: [
        { anchor: `${DETAIL} [data-objectives-tour="crew"]`, title: T("objectives.onboarding.detail.step1Title"), body: T("objectives.onboarding.detail.step1Body") },
        { anchor: `${DETAIL} [data-objectives-tour="brief"]`, title: T("objectives.onboarding.detail.step2Title"), body: T("objectives.onboarding.detail.step2Body") },
        { anchor: `${DETAIL} [data-objectives-tour="criteria"]`, title: T("objectives.onboarding.detail.step3Title"), body: T("objectives.onboarding.detail.step3Body") },
        { anchor: `${DETAIL} [data-objectives-tour="missions"]`, title: T("objectives.onboarding.detail.step4Title"), body: T("objectives.onboarding.detail.step4Body") },
        { anchor: `${DETAIL} [data-objectives-tour="action"]`, title: T("objectives.onboarding.detail.step5Title"), body: T("objectives.onboarding.detail.step5Body") },
      ],
    },
  ],
};
