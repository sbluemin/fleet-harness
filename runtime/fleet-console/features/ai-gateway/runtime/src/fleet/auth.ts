import { TYPESAFE_API_BASE_URL, TYPESAFE_AUTH_PROVIDER_ID, TYPESAFE_DEFAULT_MODEL, TYPESAFE_MODELS, validateTypesafeApiKey } from "../upstream/typesafe/index.js";
import { isAuthValidationSuccess } from "../auth/validation.js";
import { type AuthValidationFailureResult, type AuthValidationFailureStatus } from "../auth/types.js";

// 접속 좌표(저장 provider id·base URL·검증 모델)도 키 검증 기구도 core-ai-gateway가 소유한다.
// 여기서는 Admiral 표면을 유지하기 위해 좌표를 재노출하고, 공급자에 자기 검증을 적용한다.
export {
  TYPESAFE_API_BASE_URL,
  TYPESAFE_AUTH_PROVIDER_ID,
  TYPESAFE_DEFAULT_MODEL,
  TYPESAFE_MODELS,
};

export type AuthKeyValidationResult =
  | AuthValidationFailureResult
  | { readonly providerId: string; readonly status: "success" };

/**
 * System One은 Anthropic Messages wire를 말하지 않으므로 Anthropic 호환 키 검증 기구를 쓸 수 없다.
 * 대신 공급자 폴더가 소유한 프로브(모델 목록 조회)가 토큰을 쓰지 않고 키만 확인한다.
 */
export async function validateTypesafeAuthKey(apiKey: string): Promise<AuthKeyValidationResult> {
  const validation = await validateTypesafeApiKey({
    providerId: TYPESAFE_AUTH_PROVIDER_ID,
    apiKey,
    baseUrl: TYPESAFE_API_BASE_URL,
  });
  if (isAuthValidationSuccess(validation)) {
    return { providerId: TYPESAFE_AUTH_PROVIDER_ID, status: "success" };
  }
  return {
    providerId: TYPESAFE_AUTH_PROVIDER_ID,
    status: validation.status as AuthValidationFailureStatus,
    detail: validation.detail,
  };
}
