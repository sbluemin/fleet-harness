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

export type { SkillsMessageKey };
