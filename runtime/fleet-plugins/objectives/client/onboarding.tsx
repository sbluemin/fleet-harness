import type { ConsoleLocale, LocalizedText } from "@fleet-console/sdk/i18n";
import type { OnboardingContribution } from "@fleet-console/sdk/onboarding";

import { getT, type ObjectiveMessageKey } from "./i18n/index.js";

function T(key: ObjectiveMessageKey): LocalizedText {
  return (locale: ConsoleLocale) => getT(locale)(key);
}

// 목록 투어는 목록이 보일 때(상세를 열지 않았을 때)만 짚는다 — 좁은 레일에서는 상세가 목록을 display:none으로 가리지만
// DOM에는 남아 있어, 조건 없이 짚으면 보이지 않는 대상 앞에서 안내가 재생된다.
const LIST = ".objectives-root:not(.has-detail)";
const DETAIL = ".objectives-detail";

/**
 * Objectives 온보딩 — 웰컴 슬라이드, 레일 진입점 힌트, 목록·상세 투어. 이 플러그인이 문구·앵커·일러스트의 단일 원천이고,
 * 호스트는 Console 코어 기능의 온보딩 다음 순서로 보인다. 본 기록 키(objectives.welcome·objectives.rail-hint·
 * objectives.walkthrough·objectives-detail.walkthrough)는 한 번 배포하면 바꾸지 않는다.
 */
export const objectivesOnboarding: OnboardingContribution = {
  id: "objectives",
  welcome: {
    title: T("objectives.onboarding.welcome.title"),
    body: T("objectives.onboarding.welcome.body"),
    next: T("objectives.onboarding.welcome.next"),
    art: () => <ObjectivesWelcomeIllustration />,
  },
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
        { anchor: `${LIST} [data-objectives-tour="list"]`, title: T("objectives.onboarding.list.step1Title"), body: T("objectives.onboarding.list.step1Body") },
        { anchor: `${LIST} [data-objectives-tour="add"]`, title: T("objectives.onboarding.list.step2Title"), body: T("objectives.onboarding.list.step2Body"), example: T("objectives.onboarding.list.step2Example") },
        { anchor: `${LIST} .objectives-place-main[data-objectives-tour="place"]`, title: T("objectives.onboarding.list.step3Title"), body: T("objectives.onboarding.list.step3Body") },
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

/**
 * Objectives 소개 일러스트 — 목표 카드(브리핑·달성 기준)에서 임무 보드가 갈라져 나오고, 지휘관과
 * 구성원 세션이 그 임무를 나눠 맡는다. 테마 토큰만 소비한다.
 */
function ObjectivesWelcomeIllustration() {
  return (
    <svg viewBox="0 0 360 176" role="img" aria-hidden="true" focusable="false">
      <defs>
        <pattern id="objectives-welcome-dots" width="18" height="18" patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="1.5" r="1.2" fill="var(--text-tertiary)" opacity="0.35" />
        </pattern>
      </defs>
      <rect x="8" y="8" width="344" height="160" rx="10" fill="var(--canvas-sea-mid)" stroke="var(--hairline)" />
      <rect x="8" y="8" width="344" height="160" rx="10" fill="url(#objectives-welcome-dots)" />
      {/* 목표 카드 — 제목, 브리핑 줄, 달성 기준 체크 */}
      <rect x="22" y="26" width="112" height="124" rx="8" fill="var(--surface-panel)" stroke="var(--hairline-strong)" />
      <circle cx="36" cy="42" r="5" fill="none" stroke="var(--brass)" strokeWidth="1.4" />
      <rect x="47" y="39.5" width="62" height="5" rx="2.5" fill="var(--text-primary)" opacity="0.72" />
      <rect x="32" y="58" width="90" height="4" rx="2" fill="var(--text-tertiary)" opacity="0.5" />
      <rect x="32" y="67" width="72" height="4" rx="2" fill="var(--text-tertiary)" opacity="0.38" />
      {[86, 104, 122].map((y, index) => (
        <g key={y}>
          <rect x="32" y={y - 5} width="10" height="10" rx="2.5" fill={index < 2 ? "var(--positive)" : "none"} opacity={index < 2 ? 0.85 : 1} stroke={index < 2 ? "none" : "var(--text-tertiary)"} strokeWidth="1.1" />
          {index < 2 ? <path d={`M34.4 ${y}l1.9 1.9 3.4-3.6`} fill="none" stroke="var(--surface-panel)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /> : null}
          <rect x="48" y={y - 2} width={[62, 50, 70][index]} height="4" rx="2" fill="var(--text-secondary)" opacity="0.55" />
        </g>
      ))}
      {/* 임무 보드 — 선행 관계로 이어진 노드 */}
      <g fill="none" stroke="var(--hairline-strong)" strokeWidth="1.3">
        <path d="M134 88h14" />
        <path d="M176 60c14 0 10 28 26 28M176 116c14 0 10-28 26-28" />
        <path d="M230 88h14" />
      </g>
      <rect x="148" y="48" width="28" height="24" rx="6" fill="var(--surface-panel)" stroke="var(--positive)" strokeWidth="1.3" />
      <path d="M156 60l3.4 3.4 6-6.4" fill="none" stroke="var(--positive)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="148" y="104" width="28" height="24" rx="6" fill="var(--surface-panel)" stroke="var(--brass)" strokeWidth="1.3" />
      <circle cx="162" cy="116" r="4" fill="var(--brass)" opacity="0.85" />
      <rect x="202" y="76" width="28" height="24" rx="6" fill="var(--surface-panel)" stroke="var(--hairline-strong)" />
      <rect x="209" y="86.5" width="14" height="3" rx="1.5" fill="var(--text-tertiary)" opacity="0.6" />
      {/* 지휘관과 구성원 세션 */}
      <rect x="244" y="26" width="94" height="58" rx="8" fill="var(--surface-panel)" stroke="var(--brass)" strokeWidth="1.3" />
      <path d="M256 38l5-4 5 4-5 4z" fill="var(--brass)" />
      <rect x="272" y="35.5" width="50" height="5" rx="2.5" fill="var(--text-primary)" opacity="0.7" />
      <rect x="254" y="52" width="72" height="4" rx="2" fill="var(--text-tertiary)" opacity="0.5" />
      <rect x="254" y="62" width="56" height="4" rx="2" fill="var(--text-tertiary)" opacity="0.38" />
      <rect x="254" y="72" width="30" height="5" rx="2.5" fill="var(--brass)" opacity="0.7" />
      <rect x="244" y="94" width="44" height="56" rx="8" fill="var(--surface-panel)" stroke="var(--hairline-strong)" />
      <circle cx="256" cy="106" r="3.2" fill="var(--id-cerulean)" />
      <rect x="252" y="118" width="28" height="4" rx="2" fill="var(--text-tertiary)" opacity="0.5" />
      <rect x="252" y="128" width="20" height="4" rx="2" fill="var(--text-tertiary)" opacity="0.38" />
      <rect x="294" y="94" width="44" height="56" rx="8" fill="var(--surface-panel)" stroke="var(--hairline-strong)" />
      <circle cx="306" cy="106" r="3.2" fill="var(--id-teal, var(--positive))" />
      <rect x="302" y="118" width="28" height="4" rx="2" fill="var(--text-tertiary)" opacity="0.5" />
      <rect x="302" y="128" width="16" height="4" rx="2" fill="var(--text-tertiary)" opacity="0.38" />
    </svg>
  );
}
