import { ANTHROPIC_AUTH_PROVIDER_ID, validateAnthropicApiKey } from "../upstream/anthropic/index.js";
import { GEMINI_AUTH_PROVIDER_ID, validateGeminiApiKey } from "../upstream/gemini/index.js";
import { OPENCODE_AUTH_PROVIDER_ID, OPENCODE_GO_API_BASE_URL, validateOpencodeGoApiKey } from "../upstream/opencode-go/index.js";
import { isAuthValidationSuccess } from "../auth/validation.js";
import { type AuthValidationFailureResult, type AuthValidationFailureStatus, type AuthValidationResult } from "../auth/types.js";

// 접속 좌표(저장 provider id·base URL)도 키 검증 기구도 core-ai-gateway가 소유한다.
// 여기서는 Admiral 표면을 유지하기 위해 좌표를 재노출하고, 공급자에 자기 검증을 적용한다.
export {
  OPENCODE_AUTH_PROVIDER_ID,
  OPENCODE_GO_API_BASE_URL,
};

export type AuthKeyValidationResult =
  | AuthValidationFailureResult
  | { readonly providerId: string; readonly status: "success" };

/**
 * OpenCode Go는 공급자 폴더의 모델 목록 프로브로 키를 확인한다 — 범위 안의 두 모델은 모두
 * OpenAI wire라 예전의 Anthropic 1토큰 프로브가 닿을 모델이 없다. 추론 토큰을 쓰지 않는다.
 */
export async function validateOpencodeGoAuthKey(apiKey: string): Promise<AuthKeyValidationResult> {
  return toKeyValidationResult(await validateOpencodeGoApiKey({
    providerId: OPENCODE_AUTH_PROVIDER_ID,
    apiKey,
  }));
}

/**
 * Gemini API 키는 공급자 폴더의 모델 목록 프로브로 확인한다. 추론 토큰을 쓰지 않는다. 잘못된 키는
 * 401이 아니라 400 `API_KEY_INVALID`로 거절되며 그 판정은 프로브가 소유한다.
 */
export async function validateGeminiAuthKey(apiKey: string): Promise<AuthKeyValidationResult> {
  return toKeyValidationResult(await validateGeminiApiKey({
    providerId: GEMINI_AUTH_PROVIDER_ID,
    apiKey,
  }));
}

/**
 * Anthropic API 키는 공급자 폴더의 모델 목록 프로브(`GET /v1/models`)로 확인한다. 추론 토큰을 쓰지
 * 않아 크레딧을 소모하지 않는다. 잘못된 키는 401로 거절된다.
 */
export async function validateAnthropicAuthKey(apiKey: string): Promise<AuthKeyValidationResult> {
  return toKeyValidationResult(await validateAnthropicApiKey({
    providerId: ANTHROPIC_AUTH_PROVIDER_ID,
    apiKey,
  }));
}

function toKeyValidationResult(validation: AuthValidationResult): AuthKeyValidationResult {
  if (isAuthValidationSuccess(validation)) {
    return { providerId: validation.providerId, status: "success" };
  }
  return {
    providerId: validation.providerId,
    status: validation.status as AuthValidationFailureStatus,
    detail: validation.detail,
  };
}
