import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import { createTranslator } from "@fleet-console/sdk/i18n/translate";

import { LEDGER_MESSAGES, type LedgerMessageKey } from "./messages.js";

const translators: Record<ConsoleLocale, Translate<LedgerMessageKey>> = {
  en: createTranslator(LEDGER_MESSAGES, "en"),
  ko: createTranslator(LEDGER_MESSAGES, "ko"),
};

export function getT(locale: ConsoleLocale | undefined): Translate<LedgerMessageKey> {
  return translators[locale ?? "en"];
}

export type { LedgerMessageKey };
