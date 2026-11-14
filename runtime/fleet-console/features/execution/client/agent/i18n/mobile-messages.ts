import type { TerminalMessageKey } from "./index.js";

const en = {
  "terminal.settings.compactTimingCrowd": "Crowding this window. Translated providers may return 413 before automatic compaction.",
} satisfies Partial<Record<TerminalMessageKey, string>>;

const ko: Record<keyof typeof en, string> = {
  "terminal.settings.compactTimingCrowd": "이 창에 거의 찼어요. 번역 경로 공급자는 자동 압축 전에 413을 낼 수 있어요.",
};

export const MOBILE_MESSAGES = { en, ko };
