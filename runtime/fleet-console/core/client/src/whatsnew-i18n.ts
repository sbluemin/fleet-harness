import type { ConsoleLanguagePreference, ReleaseNotesLocale } from "./types.js";

// What's New UI 크롬(제목·버튼·헤딩 칩)은 영어 원형을 유지한다. 이 모듈은 릴리스 노트
// "본문" 콘텐츠의 로케일 해석만 담당한다 — auto는 브라우저 언어에서 파생된다.
export function resolveReleaseNotesLocale(preference: ConsoleLanguagePreference, navigatorLanguage = readNavigatorLanguage()): ReleaseNotesLocale {
  if (preference === "en" || preference === "ko") return preference;
  return navigatorLanguage === "ko" || navigatorLanguage.startsWith("ko-") ? "ko" : "en";
}

function readNavigatorLanguage(): string {
  return typeof navigator === "undefined" ? "" : navigator.language.toLowerCase();
}
