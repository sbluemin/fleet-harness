import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { createTranslator } from "@fleet-console/sdk/i18n/translate";

// 엔진 자신의 문구만 둔다 — 웰컴·힌트·투어의 내용 문구는 각 기여가 소유한다.
const onboardingEn = {
  "tour.skip": "Skip",
  "tour.gotIt": "Got it",
  "tour.next": "Next",
  "tour.done": "Get started",
  "tour.progress": "{current} / {total}",
  "tour.exampleLead": "Try asking:",
  "welcome.confirm": "Got it",
  "hint.open": "Open",
  "hint.dismiss": "Dismiss this hint",
  "hint.shortcut": "Shortcut {shortcut}",
  "welcome.dismiss": "Dismiss what's new",
  "welcome.previous": "Previous",
  "welcome.next": "Next",
  "welcome.slide": "{current} of {total}",
  "welcome.eyebrow": "New in Fleet",
} as const;

const onboardingKo: Record<keyof typeof onboardingEn, string> = {
  "tour.skip": "건너뛰기",
  "tour.gotIt": "알겠습니다",
  "tour.next": "다음",
  "tour.done": "시작하기",
  "tour.progress": "{current} / {total}",
  "tour.exampleLead": "이렇게 요청해 보세요.",
  "welcome.confirm": "확인",
  "hint.open": "열어 보기",
  "hint.dismiss": "안내 닫기",
  "hint.shortcut": "단축키 {shortcut}",
  "welcome.dismiss": "새 기능 소개 닫기",
  "welcome.previous": "이전",
  "welcome.next": "다음",
  "welcome.slide": "{total}개 중 {current}번째",
  "welcome.eyebrow": "새로 생긴 기능",
};

export type OnboardingMessageKey = keyof typeof onboardingEn;

export function onboardingT(locale: ConsoleLocale) {
  return createTranslator<OnboardingMessageKey>({ en: onboardingEn, ko: onboardingKo }, locale);
}
