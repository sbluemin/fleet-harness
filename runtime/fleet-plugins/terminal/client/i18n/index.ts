import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import { createTranslator } from "@fleet-console/sdk/i18n/translate";
import { React } from "@fleet-console/sdk/plugin/browser";

import { TERMINAL_MESSAGES, type TerminalMessageKey } from "./messages.js";

const translators: Record<ConsoleLocale, Translate<TerminalMessageKey>> = {
  en: createTranslator(TERMINAL_MESSAGES, "en"),
  ko: createTranslator(TERMINAL_MESSAGES, "ko"),
};

export function getT(locale: ConsoleLocale | undefined): Translate<TerminalMessageKey> {
  return translators[locale ?? "en"];
}

/** core `resolveConsoleLanguage` 와 동일 규칙 — auto 는 navigator 언어를 따른다. */
export function resolveConsoleLanguage(
  preference: string | null | undefined,
  navigatorLanguage = readNavigatorLanguage(),
): ConsoleLocale {
  if (preference === "en" || preference === "ko") return preference;
  return navigatorLanguage === "ko" || navigatorLanguage.startsWith("ko-") ? "ko" : "en";
}

/** 설정 섹션처럼 locale context 가 없을 때 전역 설정을 읽어 해석한다. */
export function useTerminalLocale(): ConsoleLocale {
  const [locale, setLocale] = React.useState<ConsoleLocale>(() => resolveConsoleLanguage("auto"));
  React.useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/v1/settings/global", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const body = await response.json() as { readonly language?: unknown };
        if (controller.signal.aborted) return;
        setLocale(resolveConsoleLanguage(typeof body.language === "string" ? body.language : "auto"));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  return locale;
}

/** 서버/클라이언트가 남긴 영어 오류 문구를 표시 직전에 카탈로그 값으로 바꾼다. */
export function translateServerMessage(locale: ConsoleLocale | undefined, message: string): string {
  const t = getT(locale);
  if (message.startsWith("Stop failed: ")) {
    return t("terminal.analysis.error.stopFailed", { message: message.slice("Stop failed: ".length) });
  }
  if (message.startsWith("Reset failed: ")) {
    return t("terminal.analysis.error.resetFailed", { message: message.slice("Reset failed: ".length) });
  }
  const key = SERVER_MESSAGE_KEYS[message];
  return key ? t(key) : message;
}

const SERVER_MESSAGE_KEYS: Readonly<Record<string, TerminalMessageKey>> = {
  "Analysis response timed out.": "terminal.analysis.error.timedOut",
  "Analysis session ended — send again to restart.": "terminal.analysis.error.sessionEnded",
  "Analysis is unavailable.": "terminal.analysis.error.unavailable",
  "Analysis session was not found.": "terminal.analysis.error.sessionNotFound",
  "Analysis request failed.": "terminal.analysis.error.requestFailed",
};

function readNavigatorLanguage(): string {
  return typeof navigator === "undefined" ? "" : navigator.language.toLowerCase();
}

export type { TerminalMessageKey };
export { TERMINAL_MESSAGES, terminalEn, terminalKo } from "./messages.js";
