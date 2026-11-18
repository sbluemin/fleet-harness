/**
 * Gemini Developer API(Google AI Studio API 키) 접속 좌표. `src/auth/`는 공급자를 모르는 채로
 * 남아야 하므로 저장 id·기반 URL은 공급자 폴더인 이 자리에 산다.
 *
 * 근거: https://ai.google.dev/gemini-api/docs (2026-11-18 확인). 인증은 `x-goog-api-key` 헤더다.
 * 2026-11-18 실측: `GET /v1beta/models`에 아래 세 모델이 있고, 잔액·한도를 알려 주는 API는 없다
 * (`/usage`·`/quota`·`/billing` 등 404). 그래서 사용량은 플릿이 응답 usageMetadata로 직접 센다.
 */

/** Quota·게이트웨이·설정이 함께 쓰는 공급자 id. Antigravity 경로의 같은 모델과 별도 항목이다. */
export const GEMINI_PROVIDER_ID = "gemini";
/** auth.json에 저장되는 공급자 id. 저장된 키가 업그레이드 뒤에도 읽히도록 바꾸지 않는다. */
export const GEMINI_AUTH_PROVIDER_ID = "Gemini API";
export const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** 사람이 고른 범위: Gemini 4 계열 3종만. 3.8 Flash 등은 넣지 않는다. */
export const GEMINI_MODEL_IDS = ["gemini-4-argon", "gemini-4-carbon", "gemini-4-hydrogen"] as const;
export type GeminiModelId = (typeof GEMINI_MODEL_IDS)[number];

export function isGeminiModelId(value: string): value is GeminiModelId {
  return (GEMINI_MODEL_IDS as readonly string[]).includes(value);
}
