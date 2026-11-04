import type { TerminalMessageKey } from "./index.js";

const en = {
  "terminal.settings.compactTimingCrowd": "Crowding this window. Translated providers may return 413 before automatic compaction.",
  "terminal.settings.aiGatewayModelsHelp": "Turn on the models delegation may use. low–high stay on.",
} satisfies Partial<Record<TerminalMessageKey, string>>;

const ko: Record<keyof typeof en, string> = {
  "terminal.settings.compactTimingCrowd": "이 창에 거의 찼어요. 번역 경로 공급자는 자동 압축 전에 413을 낼 수 있어요.",
  "terminal.settings.aiGatewayModelsHelp": "위임에 쓸 모델을 켜요. low–high는 늘 함께 켜져요.",
};

export const MOBILE_MESSAGES = { en, ko };
