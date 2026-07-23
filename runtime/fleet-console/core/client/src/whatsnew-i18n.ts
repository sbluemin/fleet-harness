import type { ConsoleLanguagePreference, ReleaseNotesLocale } from "./types.js";

// Global language preference의 해석 SSoT. What's New 본문과 plugin Operation context가
// 같은 auto 규칙을 공유하며, What's New UI 크롬 자체의 번역 범위는 소비자가 결정한다.
export function resolveReleaseNotesLocale(preference: ConsoleLanguagePreference, navigatorLanguage = readNavigatorLanguage()): ReleaseNotesLocale {
  return resolveConsoleLanguage(preference, navigatorLanguage);
}

export function resolveConsoleLanguage(preference: ConsoleLanguagePreference, navigatorLanguage = readNavigatorLanguage()): ReleaseNotesLocale {
  if (preference === "en" || preference === "ko") return preference;
  return navigatorLanguage === "ko" || navigatorLanguage.startsWith("ko-") ? "ko" : "en";
}

function readNavigatorLanguage(): string {
  return typeof navigator === "undefined" ? "" : navigator.language.toLowerCase();
}
