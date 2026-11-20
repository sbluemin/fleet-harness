import type { ConsoleLocale, Translate } from "@fleet-console/i18n";
import { createTranslator } from "@fleet-console/i18n/translate";

export const theWorldEn = {
  "theWorld.portal.label": "The World",
  "theWorld.portal.title": "The World — Enter 3D meadow village (⌘⇧W)",
  "theWorld.portal.aria": "Enter The World 3D meadow",
  "theWorld.stage.aria": "The World 3D meadow village",
  "theWorld.hud.timeGroupAria": "World time of day",
  "theWorld.hud.cameraGroupAria": "Camera perspective",
  "theWorld.hud.simGroupAria": "Simulation controls",
  "theWorld.hud.simToggleTitle": "Show or hide choreography simulation toolbar",
  "theWorld.hud.demoTitle": "Cycle demo agent display mode (Auto / Force On / Live Only)",
  "theWorld.hud.teleportGroupAria": "Quick travel meadow zones",
  "theWorld.sheet.aria": "{name} tactical sheet",
  "theWorld.sheet.closeAria": "Close sheet",
  "theWorld.sheet.inputPlaceholder": "Send message to {name}...",
};

export const theWorldKo: Record<keyof typeof theWorldEn, string> = {
  "theWorld.portal.label": "더 월드",
  "theWorld.portal.title": "더 월드 (The World) — 3D 초원 마을로 진입 (⌘⇧W)",
  "theWorld.portal.aria": "더 월드 3D 초원 진입",
  "theWorld.stage.aria": "더 월드 3D 초원 마을",
  "theWorld.hud.timeGroupAria": "월드 시간대",
  "theWorld.hud.cameraGroupAria": "카메라 시점",
  "theWorld.hud.simGroupAria": "시뮬레이션 컨트롤",
  "theWorld.hud.simToggleTitle": "협동 연출 도구모음 접기/펼치기",
  "theWorld.hud.demoTitle": "데모 에이전트 표시 모드 전환 (자동 / 강제 켜기 / 실제 데이터만)",
  "theWorld.hud.teleportGroupAria": "초원 구역 빠른 이동",
  "theWorld.sheet.aria": "{name} 제어 시트",
  "theWorld.sheet.closeAria": "시트 닫기",
  "theWorld.sheet.inputPlaceholder": "{name}에게 메시지 보내기...",
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
