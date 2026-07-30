import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import { createTranslator } from "@fleet-console/sdk/i18n/translate";

import { QUOTA_MESSAGES, type QuotaMessageKey } from "./messages.js";

const translators: Record<ConsoleLocale, Translate<QuotaMessageKey>> = {
  en: createTranslator(QUOTA_MESSAGES, "en"),
  ko: createTranslator(QUOTA_MESSAGES, "ko"),
};

export function getT(locale: ConsoleLocale | undefined): Translate<QuotaMessageKey> {
  return translators[locale ?? "en"];
}

export type { QuotaMessageKey };
