import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { createTranslator } from "@fleet-console/sdk/i18n/translate";

// 엔진 자신의 문구만 둔다 — 힌트·투어의 내용 문구는 각 기여가 소유한다.
const onboardingEn = {
  "tour.skip": "Skip",
  "tour.gotIt": "Got it",
  "tour.next": "Next",
  "tour.done": "Get started",
  "tour.progress": "{current} / {total}",
  "tour.exampleLead": "Try asking:",
  "hint.open": "Open",
  "hint.dismiss": "Dismiss this hint",
  "hint.shortcut": "Shortcut {shortcut}",
} as const;

const onboardingKo: Record<keyof typeof onboardingEn, string> = {
  "tour.skip": "건너뛰기",
  "tour.gotIt": "알겠습니다",
  "tour.next": "다음",
  "tour.done": "시작하기",
  "tour.progress": "{current} / {total}",
  "tour.exampleLead": "이렇게 요청해 보세요.",
  "hint.open": "열어 보기",
  "hint.dismiss": "안내 닫기",
  "hint.shortcut": "단축키 {shortcut}",
};

export type OnboardingMessageKey = keyof typeof onboardingEn;

export function onboardingT(locale: ConsoleLocale) {
  return createTranslator<OnboardingMessageKey>({ en: onboardingEn, ko: onboardingKo }, locale);
}
