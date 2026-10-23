import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import { createTranslator } from "@fleet-console/sdk/i18n/translate";

export { formatAbsoluteDateTime, formatDate, formatRelativeTime } from "@fleet-console/sdk/i18n/format";

import { CODEX_MESSAGES, type CodexMessageKey } from "./messages.js";

const translators: Record<ConsoleLocale, Translate<CodexMessageKey>> = {
  en: createTranslator(CODEX_MESSAGES, "en"),
  ko: createTranslator(CODEX_MESSAGES, "ko"),
};

export function getT(locale: ConsoleLocale | undefined): Translate<CodexMessageKey> {
  return translators[locale ?? "en"];
}

/**
 * 활성 로케일. 명령형 DOM 컨트롤러들이 렌더 시점 밖에서 문구를 뽑으므로, 호스트가
 * 알려준 값을 모듈에 담아 둔다 — 플러그인 번들 안이라 싱글턴 경계를 넘지 않는다.
 */
let activeLocale: ConsoleLocale = "en";

export function setActiveLocale(locale: ConsoleLocale | undefined): void {
  activeLocale = locale ?? "en";
}

export function resolveActiveLocale(): ConsoleLocale {
  return activeLocale;
}

export function useT(): Translate<CodexMessageKey> {
  return translators[activeLocale];
}

export type { CodexMessageKey };
export type CoreMessageKey = CodexMessageKey;

export { diagramHydratorLabels, markdownCopyOptions } from "./ui.js";
