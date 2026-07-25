import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import { createTranslator } from "@fleet-console/sdk/i18n/translate";

import { FILE_EXPLORER_MESSAGES, type FileExplorerMessageKey } from "./messages.js";

const translators: Record<ConsoleLocale, Translate<FileExplorerMessageKey>> = {
  en: createTranslator(FILE_EXPLORER_MESSAGES, "en"),
  ko: createTranslator(FILE_EXPLORER_MESSAGES, "ko"),
};

export function getT(locale: ConsoleLocale | undefined): Translate<FileExplorerMessageKey> {
  return translators[locale ?? "en"];
}

export type { FileExplorerMessageKey };
