import type { TerminalMessageKey } from "./index.js";

const en = {
  "terminal.settings.compactTimingCrowd": "Crowding this window. Translated providers may return 413 before automatic compaction.",
  "terminal.settings.aiGatewayModelsHelp": "Choose models and reasoning efforts available through AI Gateway.",
  "terminal.settings.aiGatewayAllExposed": "No models enabled — gateway sessions see only built-in models. Use Add model above to offer them in the /model picker.",
  "terminal.settings.aiGatewayHostOnlyTip": "Keep this model in the /model picker, but never assign it to a delegated run.",
} satisfies Partial<Record<TerminalMessageKey, string>>;

const ko: Record<keyof typeof en, string> = {
  "terminal.settings.compactTimingCrowd": "이 창에 붙어 있습니다. 번역 경로 공급자는 자동 압축 전에 413을 낼 수 있습니다.",
  "terminal.settings.aiGatewayModelsHelp": "AI Gateway를 통해 제공할 모델과 추론 강도를 고릅니다.",
  "terminal.settings.aiGatewayAllExposed": "켠 모델이 없습니다 — 게이트웨이 세션에는 내장 모델만 보입니다. 위의 모델 추가로 켜면 /model 픽커에 노출됩니다.",
  "terminal.settings.aiGatewayHostOnlyTip": "이 모델을 /model 피커에는 남기고, 위임 실행에는 배정하지 않습니다.",
};

export const MOBILE_MESSAGES = { en, ko };
