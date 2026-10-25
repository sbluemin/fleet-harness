import type { QuotaMessageKey } from "./messages.js";

const en = {
  "quota.connect.body": "Reads your local sign-in to ask Anthropic for your usage. Credentials are never stored or changed.",
  "quota.claude.signedOut": "No sign-in found. Run claude once to sign in.",
} satisfies Partial<Record<QuotaMessageKey, string>>;

const ko: Record<keyof typeof en, string> = {
  "quota.connect.body": "로컬 로그인 정보로 Anthropic에서 사용량을 가져와요. 자격 증명은 저장하거나 바꾸지 않아요.",
  "quota.claude.signedOut": "로그인 정보를 찾지 못했어요. claude를 한 번 실행해 로그인해 주세요.",
};

export const MOBILE_MESSAGES = { en, ko };
