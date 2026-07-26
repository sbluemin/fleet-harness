import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import { createTranslator } from "@fleet-console/sdk/i18n/translate";

export const scuttlebuttEn = {
  "mascot.label": "Admiral Sam",
  "chat.tuck": "Tuck away",
  "chat.placeholder": "Ask Sam anything…",
  "chat.send": "Send",
  "chat.greeting": "Mrow — ask anything that does not need a workspace. I can search the web, and I never touch your files.",
  "chat.thinking": "Sam is looking it up…",
  "followup.whoAreYou": "Who are you?",
  "followup.whatCanYouDo": "What can you do?",
  "status.searching": "Searching…",
  "status.reading": "Reading a source…",
  "status.working": "Working…",
  "arrival.one": "{title} finished",
  "arrival.many": "{count} operations finished",
  "settings.section.title": "Admiral Sam",
  "settings.section.enable": "Enable Admiral Sam",
  "settings.section.enableHint": "When off, the floating mascot is removed.",
} as const;

export type ScuttlebuttMessageKey = keyof typeof scuttlebuttEn;

export const scuttlebuttKo: Record<ScuttlebuttMessageKey, string> = {
  "mascot.label": "샘 제독",
  "chat.tuck": "치워두기",
  "chat.placeholder": "샘에게 무엇이든 물어보세요…",
  "chat.send": "보내기",
  "chat.greeting": "야옹 — 작업 공간이 필요 없는 건 뭐든 물어보세요. 웹은 찾아보지만 파일은 건드리지 않습니다.",
  "chat.thinking": "샘이 찾아보는 중…",
  "followup.whoAreYou": "너는 누구야?",
  "followup.whatCanYouDo": "뭘 할 수 있어?",
  "status.searching": "검색하는 중…",
  "status.reading": "출처를 읽는 중…",
  "status.working": "처리하는 중…",
  "arrival.one": "{title} 작업이 끝났습니다",
  "arrival.many": "Operation {count}건이 끝났습니다",
  "settings.section.title": "샘 제독",
  "settings.section.enable": "샘 제독 사용",
  "settings.section.enableHint": "끄면 떠 있는 마스코트가 사라집니다.",
};

export const SCUTTLEBUTT_MESSAGES = {
  en: scuttlebuttEn,
  ko: scuttlebuttKo,
} as const;

const translators: Record<ConsoleLocale, Translate<ScuttlebuttMessageKey>> = {
  en: createTranslator(SCUTTLEBUTT_MESSAGES, "en"),
  ko: createTranslator(SCUTTLEBUTT_MESSAGES, "ko"),
};

export function getT(locale: ConsoleLocale | undefined): Translate<ScuttlebuttMessageKey> {
  return translators[locale ?? "en"];
}
