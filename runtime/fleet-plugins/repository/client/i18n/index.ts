import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import { createTranslator } from "@fleet-console/sdk/i18n/translate";

import { REPOSITORY_MESSAGES, type RepositoryMessageKey } from "./messages.js";

const translators: Record<ConsoleLocale, Translate<RepositoryMessageKey>> = {
  en: createTranslator(REPOSITORY_MESSAGES, "en"),
  ko: createTranslator(REPOSITORY_MESSAGES, "ko"),
};

export function getT(locale: ConsoleLocale | undefined): Translate<RepositoryMessageKey> {
  return translators[locale ?? "en"];
}

/** toLocaleString / Intl에 넘길 BCP 47 태그 */
export function localeTag(locale: ConsoleLocale | undefined): string {
  return (locale ?? "en") === "ko" ? "ko-KR" : "en-US";
}

export type { RepositoryMessageKey };
export { REPOSITORY_MESSAGES } from "./messages.js";
