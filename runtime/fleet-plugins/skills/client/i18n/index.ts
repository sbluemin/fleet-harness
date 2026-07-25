import type { RenderMarkdownOptions } from "@fleet-console/markdown/core";
import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import { createTranslator } from "@fleet-console/sdk/i18n/translate";

import { SKILLS_MESSAGES, type SkillsMessageKey } from "./messages.js";

const translators: Record<ConsoleLocale, Translate<SkillsMessageKey>> = {
  en: createTranslator(SKILLS_MESSAGES, "en"),
  ko: createTranslator(SKILLS_MESSAGES, "ko"),
};

export function getT(locale: ConsoleLocale | undefined): Translate<SkillsMessageKey> {
  return translators[locale ?? "en"];
}

/** 마크다운 코드블록 Copy 라벨 — 플러그인 카탈로그에서 주입. */
export function markdownCopyOptions(
  t: Translate<SkillsMessageKey>,
): Pick<RenderMarkdownOptions, "copyLabel" | "copyAriaLabel"> {
  return {
    copyLabel: t("skills.markdown.copy"),
    copyAriaLabel: (language) => t("skills.markdown.copyCodeAria", { language }),
  };
}

export type { SkillsMessageKey };
