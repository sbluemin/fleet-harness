import type { ConsoleLocale } from "@fleet-console/i18n";
import { createTranslator } from "@fleet-console/i18n/translate";

import { browserEn, browserKo } from "./i18n.js";

/**
 * 링크 선택 카드의 말. 카드는 Session 안(채팅·CLI·Shell)과 Session 밖 Console이 함께 쓰므로
 * 브라우저 기능이 소유한다. 일시 중지·Desktop 전용 안내는 브라우저 공용 말을 그대로 빌린다.
 */
const linkOpenEn = {
  "terminal.link.cardAria": "Choose where to open this link",
  "terminal.link.objectiveRecordBrowser": "Fleet Browser",
  "terminal.link.objectiveRecordBrowserHelp": "See the same tab as this Session's agent",
  "terminal.link.webBrowser": "My Browser",
  "terminal.link.webBrowserHelp": "Opens in this computer's default browser",
} as const;

const linkOpenKo: Record<keyof typeof linkOpenEn, string> = {
  "terminal.link.cardAria": "이 링크를 어디서 열지 고르기",
  "terminal.link.objectiveRecordBrowser": "플릿 브라우저",
  "terminal.link.objectiveRecordBrowserHelp": "이 Session의 에이전트와 같은 탭을 봅니다",
  "terminal.link.webBrowser": "내 브라우저",
  "terminal.link.webBrowserHelp": "이 컴퓨터의 기본 브라우저에서 엽니다",
};

const messages = {
  en: { ...linkOpenEn, "terminal.browser.shared": browserEn["terminal.browser.shared"], "terminal.browser.desktopOnly": browserEn["terminal.browser.desktopOnly"] },
  ko: { ...linkOpenKo, "terminal.browser.shared": browserKo["terminal.browser.shared"], "terminal.browser.desktopOnly": browserKo["terminal.browser.desktopOnly"] },
};
const translators = { en: createTranslator(messages, "en"), ko: createTranslator(messages, "ko") };

export function getLinkOpenT(locale: ConsoleLocale | undefined) { return translators[locale ?? "en"]; }
