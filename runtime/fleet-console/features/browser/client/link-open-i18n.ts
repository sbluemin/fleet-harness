import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { createTranslator } from "@fleet-console/sdk/i18n/translate";

import { browserEn, browserKo } from "./i18n.js";

/**
 * 링크 선택 카드의 말. 카드는 Operation 안(채팅·CLI·Shell)과 Operation 밖 Console이 함께 쓰므로
 * 브라우저 기능이 소유한다. 일시 중지·Desktop 전용 안내는 브라우저 공용 말을 그대로 빌린다.
 */
const linkOpenEn = {
  "terminal.link.cardAria": "Choose where to open this link",
  "terminal.link.fleetBrowser": "Fleet Browser",
  "terminal.link.fleetBrowserHelp": "Opens above your current view",
  "terminal.link.operationBrowser": "Operation Browser",
  "terminal.link.operationBrowserHelp": "See the same tab as this Operation's agent",
  "terminal.link.webBrowser": "My Browser",
  "terminal.link.webBrowserHelp": "Opens in this computer's default browser",
} as const;

const linkOpenKo: Record<keyof typeof linkOpenEn, string> = {
  "terminal.link.cardAria": "이 링크를 어디서 열지 고르기",
  "terminal.link.fleetBrowser": "Fleet 브라우저",
  "terminal.link.fleetBrowserHelp": "지금 보던 화면 위에서 엽니다",
  "terminal.link.operationBrowser": "Operation 브라우저",
  "terminal.link.operationBrowserHelp": "이 Operation의 에이전트와 같은 탭을 봅니다",
  "terminal.link.webBrowser": "내 브라우저",
  "terminal.link.webBrowserHelp": "이 컴퓨터의 기본 브라우저에서 엽니다",
};

const messages = {
  en: { ...linkOpenEn, "terminal.browser.shared": browserEn["terminal.browser.shared"], "terminal.browser.desktopOnly": browserEn["terminal.browser.desktopOnly"] },
  ko: { ...linkOpenKo, "terminal.browser.shared": browserKo["terminal.browser.shared"], "terminal.browser.desktopOnly": browserKo["terminal.browser.desktopOnly"] },
};
const translators = { en: createTranslator(messages, "en"), ko: createTranslator(messages, "ko") };

export function getLinkOpenT(locale: ConsoleLocale | undefined) { return translators[locale ?? "en"]; }
