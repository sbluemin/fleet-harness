import { OPENCODE_AUTH_PROVIDER_ID, OPENCODE_GO_API_BASE_URL, validateOpencodeGoApiKey } from "../upstream/opencode-go/index.js";
import { TYPESAFE_API_BASE_URL, TYPESAFE_AUTH_PROVIDER_ID, validateTypesafeApiKey } from "../upstream/typesafe/index.js";
import { isAuthValidationSuccess } from "../auth/validation.js";
import { type AuthValidationFailureResult, type AuthValidationFailureStatus, type AuthValidationResult } from "../auth/types.js";

// 접속 좌표(저장 provider id·base URL)도 키 검증 기구도 core-ai-gateway가 소유한다.
// 여기서는 Admiral 표면을 유지하기 위해 좌표를 재노출하고, 공급자에 자기 검증을 적용한다.
export {
  OPENCODE_AUTH_PROVIDER_ID,
  OPENCODE_GO_API_BASE_URL,
  TYPESAFE_API_BASE_URL,
  TYPESAFE_AUTH_PROVIDER_ID,
};

export type AuthKeyValidationResult =
  | AuthValidationFailureResult
  | { readonly providerId: string; readonly status: "success" };

/**
 * TypeSafe는 Anthropic Messages wire를 말하지 않으므로 Anthropic 호환 키 검증 기구를 쓸 수 없다.
 * 대신 공급자 폴더가 소유한 프로브(모델 목록 조회)가 토큰을 쓰지 않고 키만 확인한다.
 */
export async function validateTypesafeAuthKey(apiKey: string): Promise<AuthKeyValidationResult> {
  return toKeyValidationResult(await validateTypesafeApiKey({
    providerId: TYPESAFE_AUTH_PROVIDER_ID,
    apiKey,
    baseUrl: TYPESAFE_API_BASE_URL,
  }));
}

/**
 * OpenCode Go도 같은 이유로 공급자 폴더의 모델 목록 프로브를 쓴다 — 범위 안의 두 모델은 모두
 * OpenAI wire라 예전의 Anthropic 1토큰 프로브가 닿을 모델이 없다.
 */
export async function validateOpencodeGoAuthKey(apiKey: string): Promise<AuthKeyValidationResult> {
  return toKeyValidationResult(await validateOpencodeGoApiKey({
    providerId: OPENCODE_AUTH_PROVIDER_ID,
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
