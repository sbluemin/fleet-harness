import type { ConsoleLocale, LocalizedText } from "@fleet-console/sdk/i18n";
import type { OnboardingContribution } from "@fleet-console/sdk/onboarding";

import { getT } from "./i18n.js";

type BrowserMessageKey = Parameters<ReturnType<typeof getT>>[0];

function T(key: BrowserMessageKey): LocalizedText {
  return (locale: ConsoleLocale) => getT(locale)(key);
}

/**
 * Operation Browser 온보딩 — 웰컴 슬라이드와 캡션 지구본 투어. 웰컴이 기능을 가볍게 알리고, 실제 사용법(예시 프롬프트)은
 * Operation을 열었을 때 캡션의 지구본에 서는 투어가 이어받는다. 본 기록 키(operation-browser.welcome·
 * operation-browser.walkthrough)는 이미 배포된 키다.
 */
export const browserOnboarding: OnboardingContribution = {
  id: "operation-browser",
  welcome: {
    title: T("terminal.browser.onboarding.welcome.title"),
    body: T("terminal.browser.onboarding.welcome.body"),
    next: T("terminal.browser.onboarding.welcome.next"),
    art: () => <BrowserWelcomeIllustration />,
  },
  tours: [
    {
      id: "operation-browser",
      // 앵커는 Operation 캡션의 브라우저 문 — 에이전트 Operation이면 늘 있으므로 첫 캡션에서 뜬다. 덱 카드의 캡션은 그 버튼을
      // 숨기고 최소화·숨김 패널의 캡션은 보이지 않으므로 펼쳐진 무대의 캡션만 짚는다. 첫 방문의 모드 투어와 겹치지 않게
      // 한 박자 미룬다.
      spotlight: null,
      deferAfterAnotherTour: true,
      walkthrough: [
        {
          anchor: '.canvas-operation:not(.is-deck-tile):not(.is-minimized) [data-chat-tour="browser"]',
          title: T("terminal.browser.onboarding.tour.step1Title"),
          body: T("terminal.browser.onboarding.tour.step1Body"),
          example: T("terminal.browser.onboarding.tour.step1Example"),
        },
      ],
    },
  ],
};

/** Operation Browser 소개 일러스트 — 캔버스 위의 Operation 패널 옆에 선 브라우저 companion. 테마 토큰만 소비한다. */
function BrowserWelcomeIllustration() {
  return (
    <svg viewBox="0 0 360 176" role="img" aria-hidden="true" focusable="false">
      <defs>
        <pattern id="browser-welcome-dots" width="18" height="18" patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="1.5" r="1.2" fill="var(--text-tertiary)" opacity="0.35" />
        </pattern>
      </defs>
      {/* 캔버스(Map) */}
      <rect x="8" y="8" width="344" height="160" rx="10" fill="var(--canvas-sea-mid)" stroke="var(--hairline)" />
      <rect x="8" y="8" width="344" height="160" rx="10" fill="url(#browser-welcome-dots)" />
      {/* Operation 패널 — 캡션의 지구본 문이 brass 로 켜져 있다 */}
      <rect x="26" y="30" width="138" height="116" rx="8" fill="var(--surface-panel)" stroke="var(--hairline)" />
      <rect x="26" y="30" width="138" height="22" rx="8" fill="none" stroke="var(--hairline)" />
      <circle cx="38" cy="41" r="3" fill="var(--positive)" />
      <rect x="48" y="38.5" width="52" height="5" rx="2.5" fill="var(--text-secondary)" opacity="0.6" />
      <g transform="translate(139 34)">
        <rect x="0" y="0" width="16" height="14" rx="3" fill="var(--brass)" opacity="0.22" />
        <circle cx="8" cy="7" r="4.6" fill="none" stroke="var(--brass)" strokeWidth="1.3" />
        <path d="M3.4 7h9.2M8 2.4c1.7 1.6 1.7 7.6 0 9.2M8 2.4c-1.7 1.6-1.7 7.6 0 9.2" fill="none" stroke="var(--brass)" strokeWidth="1.1" />
      </g>
      <rect x="38" y="64" width="86" height="5" rx="2.5" fill="var(--text-tertiary)" opacity="0.55" />
      <rect x="38" y="78" width="108" height="5" rx="2.5" fill="var(--text-tertiary)" opacity="0.4" />
      <rect x="38" y="92" width="70" height="5" rx="2.5" fill="var(--text-tertiary)" opacity="0.5" />
      <rect x="38" y="106" width="96" height="5" rx="2.5" fill="var(--text-tertiary)" opacity="0.35" />
      <rect x="38" y="126" width="60" height="6" rx="3" fill="var(--brass)" opacity="0.75" />
      {/* 브라우저 companion — 탭 스트립·주소 필·페이지 */}
      <rect x="178" y="30" width="158" height="116" rx="8" fill="var(--surface-panel)" stroke="var(--hairline-strong)" />
      <rect x="178" y="30" width="158" height="22" rx="8" fill="none" stroke="var(--hairline-strong)" />
      <g transform="translate(186 35)">
        <circle cx="6" cy="6" r="4.4" fill="none" stroke="var(--text-secondary)" strokeWidth="1.2" />
        <path d="M1.6 6h8.8M6 1.6c1.6 1.5 1.6 7.3 0 8.8M6 1.6c-1.6 1.5-1.6 7.3 0 8.8" fill="none" stroke="var(--text-secondary)" strokeWidth="1" />
      </g>
      <rect x="204" y="35" width="58" height="12" rx="3" fill="var(--ink-veil)" stroke="var(--hairline-strong)" />
      <rect x="209" y="39.5" width="6" height="3" rx="1.5" fill="var(--aurora)" />
      <rect x="219" y="39.5" width="34" height="3" rx="1.5" fill="var(--text-primary)" opacity="0.7" />
      <rect x="270" y="39.5" width="8" height="3" rx="1.5" fill="var(--text-tertiary)" opacity="0.6" />
      <rect x="196" y="60" width="122" height="12" rx="6" fill="var(--ink-veil)" />
      <rect x="230" y="64.5" width="54" height="3" rx="1.5" fill="var(--text-primary)" opacity="0.7" />
      <rect x="186" y="80" width="142" height="58" rx="4" fill="var(--ink-pearl)" opacity="0.92" />
      <rect x="198" y="90" width="64" height="6" rx="3" fill="var(--ink-abyss)" opacity="0.7" />
      <rect x="198" y="104" width="118" height="4" rx="2" fill="var(--ink-abyss)" opacity="0.3" />
      <rect x="198" y="114" width="96" height="4" rx="2" fill="var(--ink-abyss)" opacity="0.3" />
      <rect x="198" y="124" width="40" height="8" rx="4" fill="var(--id-cerulean)" opacity="0.9" />
      {/* 에이전트 사용 중 — 보라 링이 companion 을 두른다 */}
      <rect x="180" y="32" width="154" height="112" rx="7" fill="none" stroke="var(--agent-control-badge)" strokeWidth="1.6" opacity="0.8" />
    </svg>
  );
}
