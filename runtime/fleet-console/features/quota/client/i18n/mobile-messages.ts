import type { QuotaMessageKey } from "./messages.js";

/** 폰 전용 문구. 지금은 데스크톱과 다른 문구가 없다 — 다를 때만 여기에 더한다. */
const en = {} satisfies Partial<Record<QuotaMessageKey, string>>;

const ko: Record<keyof typeof en, string> = {};

export const MOBILE_MESSAGES = { en, ko };
