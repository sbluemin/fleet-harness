import { useMemo } from "react";

import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import { createTranslator } from "@fleet-console/sdk/i18n/translate";

import { useGlobalSettingsStore } from "../../../../features/settings/client/global-settings-store.js";
import { resolveConsoleLanguage } from "../../../../features/updates/client/whatsnew-i18n.js";
import { CORE_MESSAGES, type CoreMessageKey } from "./messages/index.js";
import { MOBILE_MESSAGES } from "./mobile-messages.js";

const translators: Record<ConsoleLocale, Translate<CoreMessageKey>> = {
  en: createTranslator(CORE_MESSAGES, "en"),
  ko: createTranslator(CORE_MESSAGES, "ko"),
};

export function useConsoleLocale(): ConsoleLocale {
  const globalSettings = useGlobalSettingsStore();
  return resolveConsoleLanguage(globalSettings.state?.language ?? "auto");
}

const mobileMessages = {
  en: { ...CORE_MESSAGES.en, ...MOBILE_MESSAGES.en },
  ko: { ...CORE_MESSAGES.ko, ...MOBILE_MESSAGES.ko },
};
const mobileTranslators: Record<ConsoleLocale, Translate<CoreMessageKey>> = {
  en: createTranslator(mobileMessages, "en"),
  ko: createTranslator(mobileMessages, "ko"),
};

export function useT(mobile = false): Translate<CoreMessageKey> {
  const locale = useConsoleLocale();
  return useMemo(() => getT(locale, mobile), [locale, mobile]);
}

export function getT(locale: ConsoleLocale, mobile = false): Translate<CoreMessageKey> {
  return (mobile ? mobileTranslators : translators)[locale];
}

export type { CoreMessageKey };
export { CORE_MESSAGES } from "./messages/index.js";
export { diagramHydratorLabels, markdownCopyOptions } from "./ui.js";
export { formatAbsoluteDateTime, formatDate, formatRelativeTime } from "./format.js";
export { renderMessage, translateServerError } from "./ui.js";
