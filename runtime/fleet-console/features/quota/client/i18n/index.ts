import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import { createTranslator } from "@fleet-console/sdk/i18n/translate";

import { QUOTA_MESSAGES, type QuotaMessageKey } from "./messages.js";
import { MOBILE_MESSAGES } from "./mobile-messages.js";

const translators: Record<ConsoleLocale, Translate<QuotaMessageKey>> = {
  en: createTranslator(QUOTA_MESSAGES, "en"),
  ko: createTranslator(QUOTA_MESSAGES, "ko"),
};

const mobileMessages = {
  en: { ...QUOTA_MESSAGES.en, ...MOBILE_MESSAGES.en },
  ko: { ...QUOTA_MESSAGES.ko, ...MOBILE_MESSAGES.ko },
};
const mobileTranslators: Record<ConsoleLocale, Translate<QuotaMessageKey>> = {
  en: createTranslator(mobileMessages, "en"),
  ko: createTranslator(mobileMessages, "ko"),
};

export function getT(locale: ConsoleLocale | undefined, mobile = false): Translate<QuotaMessageKey> {
  return (mobile ? mobileTranslators : translators)[locale ?? "en"];
}

export type { QuotaMessageKey };
