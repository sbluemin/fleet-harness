import type { QuotaMessageKey } from "./messages.js";

const en = {
  "quota.connect.body": "Reads your local sign-in to ask Anthropic for your usage. Credentials are never stored or changed.",
  "quota.claude.signedOut": "No sign-in found. Run claude once to sign in.",
} satisfies Partial<Record<QuotaMessageKey, string>>;

const ko: Record<keyof typeof en, string> = {
  "quota.connect.body": "로컬 로그인 정보로 Anthropic에 사용량을 조회합니다. 자격증명은 저장되거나 변경되지 않습니다.",
  "quota.claude.signedOut": "로그인 정보를 찾지 못했습니다. claude를 한 번 실행해 로그인하세요.",
};

export const MOBILE_MESSAGES = { en, ko };
