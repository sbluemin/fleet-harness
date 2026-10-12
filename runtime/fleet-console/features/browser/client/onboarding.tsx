import type { ConsoleLocale, LocalizedText } from "@fleet-console/sdk/i18n";
import type { OnboardingContribution } from "@fleet-console/sdk/onboarding";

import { getT } from "./i18n.js";

type BrowserMessageKey = Parameters<ReturnType<typeof getT>>[0];

function T(key: BrowserMessageKey): LocalizedText {
  return (locale: ConsoleLocale) => getT(locale)(key);
}

/**
 * Operation Browser 온보딩 — 캡션 지구본 투어. 실제 사용법(예시 프롬프트)은 Operation을 열었을 때 캡션의 지구본에
 * 서는 투어가 알린다. 본 기록 키(operation-browser.walkthrough)는 이미 배포된 키다.
 */
export const browserOnboarding: OnboardingContribution = {
  id: "operation-browser",
  tours: [
    {
      id: "operation-browser",
      // 앵커는 대화 화면 캡션의 브라우저 문 — 에이전트 Operation이면 늘 있으므로 첫 캡션에서 뜬다.
      // 첫 방문의 다른 투어와 겹치지 않게 한 박자 미룬다.
      spotlight: null,
      deferAfterAnotherTour: true,
      walkthrough: [
        {
          anchor: '[data-chat-tour="browser"]',
          title: T("terminal.browser.onboarding.tour.step1Title"),
          body: T("terminal.browser.onboarding.tour.step1Body"),
          example: T("terminal.browser.onboarding.tour.step1Example"),
        },
      ],
    },
  ],
};
