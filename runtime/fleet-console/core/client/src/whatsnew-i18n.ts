import type { ConsoleLanguagePreference, ReleaseNotesLocale } from "./types.js";

interface WhatsNewCopy {
  readonly close: string;
  readonly closeAria: string;
  readonly englishFallback: string;
  readonly language: string;
  readonly newerVersions: string;
  readonly olderVersions: string;
  readonly refresh: string;
  readonly refreshing: string;
  readonly refreshError: string;
  readonly releaseSelector: string;
  readonly released: string;
  readonly stale: string;
  readonly title: string;
  readonly unreleased: string;
  readonly sections: Readonly<Record<string, string>>;
}

export const WHATSNEW_COPY = {
  en: {
    close: "Close",
    closeAria: "Close What's new",
    englishFallback: "English fallback",
    language: "Language",
    newerVersions: "Newer versions",
    olderVersions: "Older versions",
    refresh: "Refresh",
    refreshing: "Refreshing",
    refreshError: "Release notes could not be refreshed.",
    releaseSelector: "Release version",
    released: "Released",
    stale: "Stale",
    title: "What's new",
    unreleased: "Unreleased",
    sections: {
      Added: "Added",
      Changed: "Changed",
      Fixed: "Fixed",
      Removed: "Removed",
      "Breaking Changes": "Breaking Changes",
    },
  },
  ko: {
    close: "닫기",
    closeAria: "새 소식 닫기",
    englishFallback: "영어 원문",
    language: "언어",
    newerVersions: "더 최신 버전",
    olderVersions: "더 이전 버전",
    refresh: "새로 고침",
    refreshing: "새로 고치는 중",
    refreshError: "릴리스 노트를 새로 고칠 수 없습니다.",
    releaseSelector: "릴리스 버전",
    released: "릴리스",
    stale: "오래된 정보",
    title: "새 소식",
    unreleased: "미출시",
    sections: {
      Added: "추가됨",
      Changed: "변경됨",
      Fixed: "수정됨",
      Removed: "제거됨",
      "Breaking Changes": "호환성 변경",
    },
  },
} satisfies Record<ReleaseNotesLocale, WhatsNewCopy>;

export function resolveReleaseNotesLocale(preference: ConsoleLanguagePreference, navigatorLanguage = readNavigatorLanguage()): ReleaseNotesLocale {
  if (preference === "en" || preference === "ko") return preference;
  return navigatorLanguage === "ko" || navigatorLanguage.startsWith("ko-") ? "ko" : "en";
}

export function getWhatsNewSectionLabel(locale: ReleaseNotesLocale, heading: string): string {
  const copy: WhatsNewCopy = WHATSNEW_COPY[locale];
  return copy.sections[heading] ?? heading;
}

function readNavigatorLanguage(): string {
  return typeof navigator === "undefined" ? "" : navigator.language.toLowerCase();
}
