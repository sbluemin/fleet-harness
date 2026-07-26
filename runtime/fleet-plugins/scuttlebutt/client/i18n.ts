import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import { createTranslator } from "@fleet-console/sdk/i18n/translate";

export const scuttlebuttEn = {
  "mascot.label": "Admiral Tori",
  "chat.tuck": "Tuck away",
  "chat.placeholder": "Ask Tori anything…",
  "chat.send": "Send",
  "chat.greeting": "Tori on the bridge — ask anything that does not need a workspace. I can search the web, and I never touch your files.",
  "chat.thinking": "Tori is looking it up…",
  "followup.whoAreYou": "Who are you?",
  "followup.whatCanYouDo": "What can you do?",
  "status.searching": "Searching…",
  "status.reading": "Reading a source…",
  "status.working": "Working…",
  "arrival.one": "{title} finished",
  "arrival.many": "{count} operations finished",
  "settings.section.title": "Quaker Admirals",
  "settings.section.enable": "Enable the Quaker Admirals",
  "settings.section.enableHint": "When off, all three floating admirals are removed.",
  "bird.tori": "Tori",
  "bird.bori": "Bori",
  "bird.dori": "Dori",
  "line.bori.1": "Signal received, loud and clear!",
  "line.bori.2": "Run up the flags!",
  "line.bori.3": "Courier Bori — dispatch coming through!",
  "line.dori.1": "Patrol reports nothing unusual.",
  "line.dori.2": "Dori entering the patrol route.",
  "line.dori.3": "Carrier streams are steady.",
} as const;

export type ScuttlebuttMessageKey = keyof typeof scuttlebuttEn;

export const scuttlebuttKo: Record<ScuttlebuttMessageKey, string> = {
  "mascot.label": "토리 제독",
  "chat.tuck": "치워두기",
  "chat.placeholder": "토리에게 무엇이든 물어보세요…",
  "chat.send": "보내기",
  "chat.greeting": "함교의 토리입니다 — 작업 공간이 필요 없는 건 뭐든 물어보세요. 웹은 찾아보지만 파일은 건드리지 않습니다.",
  "chat.thinking": "토리가 찾아보는 중…",
  "followup.whoAreYou": "너는 누구야?",
  "followup.whatCanYouDo": "뭘 할 수 있어?",
  "status.searching": "검색하는 중…",
  "status.reading": "출처를 읽는 중…",
  "status.working": "처리하는 중…",
  "arrival.one": "{title} 작업이 끝났습니다",
  "arrival.many": "Operation {count}건이 끝났습니다",
  "settings.section.title": "퀘이커 제독단",
  "settings.section.enable": "퀘이커 제독단 사용",
  "settings.section.enableHint": "끄면 떠다니는 제독 셋이 모두 사라집니다.",
  "bird.tori": "토리",
  "bird.bori": "보리",
  "bird.dori": "도리",
  "line.bori.1": "신호 수신 양호!",
  "line.bori.2": "깃발 올려!",
  "line.bori.3": "보리 전령, 급보 있음!",
  "line.dori.1": "초계 이상 무!",
  "line.dori.2": "도리, 초계 항로 진입.",
  "line.dori.3": "캐리어 스트림 정상.",
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
