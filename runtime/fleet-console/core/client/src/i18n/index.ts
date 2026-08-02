import { useMemo } from "react";

import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import { createTranslator } from "@fleet-console/sdk/i18n/translate";

import { useGlobalSettingsStore } from "../global-settings-store.js";
import { resolveConsoleLanguage } from "../whatsnew-i18n.js";
import { CORE_MESSAGES, type CoreMessageKey } from "./messages/index.js";

const translators: Record<ConsoleLocale, Translate<CoreMessageKey>> = {
  en: createTranslator(CORE_MESSAGES, "en"),
  ko: createTranslator(CORE_MESSAGES, "ko"),
};

export function useConsoleLocale(): ConsoleLocale {
  const globalSettings = useGlobalSettingsStore();
  return resolveConsoleLanguage(globalSettings.state?.language ?? "auto");
}

export function useT(): Translate<CoreMessageKey> {
  const locale = useConsoleLocale();
  return useMemo(() => getT(locale), [locale]);
}

export function getT(locale: ConsoleLocale): Translate<CoreMessageKey> {
  return translators[locale];
}

export type { CoreMessageKey };
export { CORE_MESSAGES } from "./messages/index.js";
export { diagramHydratorLabels, markdownCopyOptions } from "./ui.js";
export { formatAbsoluteDateTime, formatDate, formatRelativeTime } from "./format.js";
export { renderMessage, translateServerError } from "./ui.js";
