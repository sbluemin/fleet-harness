import type { ConsoleLocale, Translate } from "@fleet-console/i18n";
import { createTranslator } from "@fleet-console/i18n/translate";

export const theWorldEn = {
  "theWorld.portal.label": "The World",
  "theWorld.portal.title": "The World — Enter 3D meadow village (⌘⇧W)",
  "theWorld.portal.aria": "Enter The World 3D meadow",
  "theWorld.stage.aria": "The World 3D meadow village",
  "theWorld.hud.timeGroupAria": "World time of day",
  "theWorld.hud.cameraGroupAria": "Camera perspective",
  "theWorld.hud.simGroupAria": "Choreography controls",
  "theWorld.hud.simToggleTitle": "Show or hide choreography toolbar",
  "theWorld.hud.teleportGroupAria": "Quick travel meadow zones",
  "theWorld.radial.aria": "Interaction menu for {name}",
  "theWorld.radial.closeAria": "Close interaction menu",
  "theWorld.dialogue.aria": "Conversation with {name}",
  "theWorld.dialogue.closeAria": "Close dialogue",
  "theWorld.dialogue.backAria": "Return to interaction wheel",
  "theWorld.dialogue.inputPlaceholder": "Speak or give orders to {name}...",
  "theWorld.actor.interactAria": "Interact with {name}",
};

export const theWorldKo: Record<keyof typeof theWorldEn, string> = {
  "theWorld.portal.label": "더 월드",
  "theWorld.portal.title": "더 월드 (The World) — 3D 초원 마을로 진입 (⌘⇧W)",
  "theWorld.portal.aria": "더 월드 3D 초원 진입",
  "theWorld.stage.aria": "더 월드 3D 초원 마을",
  "theWorld.hud.timeGroupAria": "월드 시간대",
  "theWorld.hud.cameraGroupAria": "카메라 시점",
  "theWorld.hud.simGroupAria": "협동 연출 컨트롤",
  "theWorld.hud.simToggleTitle": "협동 연출 도구모음 접기/펼치기",
  "theWorld.hud.teleportGroupAria": "초원 구역 빠른 이동",
  "theWorld.radial.aria": "{name} 상호작용 메뉴",
  "theWorld.radial.closeAria": "상호작용 메뉴 닫기",
  "theWorld.dialogue.aria": "{name}과의 대화창",
  "theWorld.dialogue.closeAria": "대화창 닫기",
  "theWorld.dialogue.backAria": "상호작용 휠로 돌아가기",
  "theWorld.dialogue.inputPlaceholder": "{name}에게 말 걸기 또는 지시 입력...",
  "theWorld.actor.interactAria": "{name}와 상호작용",
};

export type TheWorldMessageKey = keyof typeof theWorldEn;

const messages = { en: theWorldEn, ko: theWorldKo } as const;

const translators: Record<ConsoleLocale, Translate<TheWorldMessageKey>> = {
  en: createTranslator(messages, "en"),
  ko: createTranslator(messages, "ko"),
};

export function getWorldT(locale: ConsoleLocale | undefined): Translate<TheWorldMessageKey> {
  if (locale === "ko" || locale === "en") return translators[locale];
  const docLang = typeof document !== "undefined" ? document.documentElement.lang : "";
  return docLang.startsWith("ko") ? translators.ko : translators.en;
}
