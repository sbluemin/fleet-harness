import { canvasEn, canvasKo } from "./canvas.js";
import { chromeEn, chromeKo } from "./chrome.js";
import { commonEn, commonKo } from "./common.js";
import { pagesEn, pagesKo } from "./pages.js";
import { theaterInboxEn, theaterInboxKo } from "./theater-inbox.js";

export const CORE_MESSAGES = {
  en: { ...commonEn, ...chromeEn, ...canvasEn, ...pagesEn, ...theaterInboxEn },
  ko: { ...commonKo, ...chromeKo, ...canvasKo, ...pagesKo, ...theaterInboxKo },
} as const;

export type CoreMessageKey = keyof typeof CORE_MESSAGES.en;
