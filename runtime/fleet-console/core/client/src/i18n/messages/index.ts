import { chromeEn, chromeKo } from "./chrome.js";
import { commonEn, commonKo } from "./common.js";
import { pagesEn, pagesKo } from "./pages.js";
import { theaterInboxEn, theaterInboxKo } from "./theater-inbox.js";
import { workspaceEn, workspaceKo } from "./workspace.js";

export const CORE_MESSAGES = {
  en: { ...commonEn, ...chromeEn, ...workspaceEn, ...pagesEn, ...theaterInboxEn },
  ko: { ...commonKo, ...chromeKo, ...workspaceKo, ...pagesKo, ...theaterInboxKo },
} as const;

export type CoreMessageKey = keyof typeof CORE_MESSAGES.en;
