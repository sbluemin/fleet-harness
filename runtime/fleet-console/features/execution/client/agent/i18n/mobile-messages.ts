import type { TerminalMessageKey } from "./index.js";

const en = {
  "terminal.settings.compactTimingCrowd": "Crowding this window. Translated providers may return 413 before automatic compaction.",
  "terminal.settings.aiGatewayModelsHelp": "Turn on models for delegation. low and medium stay on; high starts on and can be turned off.",
} satisfies Partial<Record<TerminalMessageKey, string>>;

const ko: Record<keyof typeof en, string> = {
  "terminal.settings.compactTimingCrowd": "이 창에 거의 찼어요. 번역 경로 공급자는 자동 압축 전에 413을 낼 수 있어요.",
  "terminal.settings.aiGatewayModelsHelp": "위임에 쓸 모델을 켜요. low·medium은 늘 포함하고, 처음에 켜진 high는 끌 수 있어요.",
};

export const MOBILE_MESSAGES = { en, ko };
