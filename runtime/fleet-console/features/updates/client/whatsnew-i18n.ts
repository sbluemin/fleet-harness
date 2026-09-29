import type { ConsoleLanguagePreference, ReleaseNotesLocale } from "../../../core/client/src/integration/types.js";

// Global language preference의 해석 SSoT. What's New 본문과 plugin Operation context가
// 같은 auto 규칙을 공유하며, What's New UI 크롬 자체의 번역 범위는 소비자가 결정한다.
export function resolveReleaseNotesLocale(preference: ConsoleLanguagePreference, navigatorLanguage = readNavigatorLanguage()): ReleaseNotesLocale {
  return resolveConsoleLanguage(preference, navigatorLanguage);
}

export function resolveConsoleLanguage(preference: ConsoleLanguagePreference, navigatorLanguage = readNavigatorLanguage()): ReleaseNotesLocale {
  if (preference === "en" || preference === "ko") return preference;
  return navigatorLanguage === "ko" || navigatorLanguage.startsWith("ko-") ? "ko" : "en";
}

// 언어 해석은 번역 훅마다(=렌더마다) 돈다 — 브라우저 언어는 같은 navigator에서 languagechange가 오기 전까지 다시 읽지 않는다.
let navigatorLanguageFor: Navigator | null = null;
let navigatorLanguage = "";
let languageListening = false;
function readNavigatorLanguage(): string {
  if (typeof navigator === "undefined") return "";
  if (navigator !== navigatorLanguageFor) {
    navigatorLanguageFor = navigator;
    navigatorLanguage = navigator.language.toLowerCase();
    if (!languageListening && typeof window !== "undefined" && typeof window.addEventListener === "function") {
      languageListening = true;
      window.addEventListener("languagechange", () => { navigatorLanguageFor = null; });
    }
  }
  return navigatorLanguage;
}
