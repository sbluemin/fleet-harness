import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import { createTranslator } from "@fleet-console/sdk/i18n/translate";

export const scuttlebuttEn = {
  "chat.label.tori": "Admiral Tori",
  "chat.label.bori": "Admiral Bori",
  "chat.label.dori": "Admiral Dori",
  "chat.tuck": "Tuck away",
  "chat.stayPut": "Stay put",
  "chat.placeholder.tori": "Ask Tori anything…",
  "chat.placeholder.bori": "Ask Bori anything…",
  "chat.placeholder.dori": "Ask Dori anything…",
  "chat.send": "Send",
  "chat.greeting.tori": "Tori, on the flagship bridge. Ask anything that needs no workspace — including why the sea is salty. I search the web and never touch your files.",
  "chat.greeting.bori": "Bori here! Signals up! Throw me anything quick — I search the web, I never touch your files!",
  "chat.greeting.dori": "Dori, just in from patrol. Hand me anything worth checking — I search the web and never touch your files.",
  "chat.thinking.tori": "Tori is looking into it…",
  "chat.thinking.bori": "Bori is running it down…",
  "chat.thinking.dori": "Dori is scouting it out…",
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
  "settings.section.roster": "Admirals on duty",
  "settings.section.rosterHint": "Each admiral keeps their own chat.",
  "bird.tori": "Tori",
  "bird.bori": "Bori",
  "bird.dori": "Dori",
  "line.tori.1": "All ships, hold your course.",
  "line.tori.2": "Flagship reports all clear.",
  "line.tori.3": "Tori holding station.",
  "line.bori.1": "Signal received, loud and clear!",
  "line.bori.2": "Run up the flags!",
  "line.bori.3": "Courier Bori — dispatch coming through!",
  "line.dori.1": "Patrol reports nothing unusual.",
  "line.dori.2": "Dori entering the patrol route.",
  "line.dori.3": "Carrier streams are steady.",
} as const;

export type ScuttlebuttMessageKey = keyof typeof scuttlebuttEn;

export const scuttlebuttKo: Record<ScuttlebuttMessageKey, string> = {
  "chat.label.tori": "토리 제독",
  "chat.label.bori": "보리 제독",
  "chat.label.dori": "도리 제독",
  "chat.tuck": "치워두기",
  "chat.stayPut": "제자리에 두기",
  "chat.placeholder.tori": "토리에게 무엇이든 물어보세요…",
  "chat.placeholder.bori": "보리에게 무엇이든 물어보세요…",
  "chat.placeholder.dori": "도리에게 무엇이든 물어보세요…",
  "chat.send": "보내기",
  "chat.greeting.tori": "기함 함교의 토리입니다. 작업 공간이 필요 없는 일이라면 무엇이든 — 바다가 왜 짠지까지도 — 물어보십시오. 웹은 찾아보지만 파일은 건드리지 않습니다.",
  "chat.greeting.bori": "보리! 신호 대기 중입니다! 빠른 질문이면 뭐든 던지세요. 웹은 뒤지고, 파일은 안 건드립니다!",
  "chat.greeting.dori": "초계에서 막 돌아온 도리입니다. 확인이 필요한 것이 있으면 맡겨 주십시오. 웹은 살피되 파일에는 손대지 않습니다.",
  "chat.thinking.tori": "토리가 살펴보는 중…",
  "chat.thinking.bori": "보리가 신호를 받는 중…",
  "chat.thinking.dori": "도리가 정찰하는 중…",
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
  "settings.section.roster": "출근 중인 제독",
  "settings.section.rosterHint": "제독마다 대화가 따로 유지됩니다.",
  "bird.tori": "토리",
  "bird.bori": "보리",
  "bird.dori": "도리",
  "line.tori.1": "전 함대, 항로 유지.",
  "line.tori.2": "기함은 이상 무.",
  "line.tori.3": "토리, 현 위치 사수.",
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
