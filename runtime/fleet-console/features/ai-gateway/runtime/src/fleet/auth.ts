import { KIMI_AUTH_PROVIDER_ID, KIMI_CODE_API_BASE_URL, KIMI_CODE_MODEL } from "../models.js";
import { OPENCODE_AUTH_PROVIDER_ID, OPENCODE_GO_API_BASE_URL, OPENCODE_GO_MODEL } from "../upstream/opencode-go/index.js";
import { TYPESAFE_API_BASE_URL, TYPESAFE_AUTH_PROVIDER_ID, TYPESAFE_DEFAULT_MODEL, TYPESAFE_MODELS, validateTypesafeApiKey } from "../upstream/typesafe/index.js";
import { isAuthValidationSuccess, validateAnthropicCompatibleApiKey } from "../auth/validation.js";
import { type AuthValidationFailureResult, type AuthValidationFailureStatus } from "../auth/types.js";

// 접속 좌표(저장 provider id·base URL·검증 모델)도 키 검증 기구도 core-ai-gateway가 소유한다.
// 여기서는 Admiral 표면을 유지하기 위해 좌표를 재노출하고, 각 공급자에 자기 검증을 적용한다.
// Anthropic 호환 두 공급자는 공용 기구를 쓰고, TypeSafe는 자기 wire의 프로브를 쓴다.
export {
  KIMI_AUTH_PROVIDER_ID,
  KIMI_CODE_API_BASE_URL,
  KIMI_CODE_MODEL,
  OPENCODE_AUTH_PROVIDER_ID,
  OPENCODE_GO_API_BASE_URL,
  OPENCODE_GO_MODEL,
  TYPESAFE_API_BASE_URL,
  TYPESAFE_AUTH_PROVIDER_ID,
  TYPESAFE_DEFAULT_MODEL,
  TYPESAFE_MODELS,
};

export type AuthKeyValidationResult =
  | AuthValidationFailureResult
  | { readonly providerId: string; readonly status: "success" };

export async function validateKimiAuthKey(apiKey: string): Promise<AuthKeyValidationResult> {
  return validateAnthropicCompatibleAuthKey(apiKey, {
    providerId: KIMI_AUTH_PROVIDER_ID,
    baseUrl: KIMI_CODE_API_BASE_URL,
    model: KIMI_CODE_MODEL,
  });
}

export async function validateOpencodeGoAuthKey(apiKey: string): Promise<AuthKeyValidationResult> {
  return validateAnthropicCompatibleAuthKey(apiKey, {
    providerId: OPENCODE_AUTH_PROVIDER_ID,
    baseUrl: OPENCODE_GO_API_BASE_URL,
    model: OPENCODE_GO_MODEL,
  });
}

/**
 * System One은 Anthropic Messages wire를 말하지 않으므로 위의 기구를 쓸 수 없다. 대신
 * 공급자 폴더가 소유한 프로브(모델 목록 조회)가 토큰을 쓰지 않고 키만 확인한다.
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

async function validateAnthropicCompatibleAuthKey(
  apiKey: string,
  coordinates: { readonly providerId: string; readonly baseUrl: string; readonly model: string },
): Promise<AuthKeyValidationResult> {
  const validation = await validateAnthropicCompatibleApiKey({
    providerId: coordinates.providerId,
    apiKey,
    baseUrl: coordinates.baseUrl,
    model: coordinates.model,
  });
  if (isAuthValidationSuccess(validation)) {
    return { providerId: coordinates.providerId, status: "success" };
  }
  return {
    providerId: coordinates.providerId,
    status: validation.status as AuthValidationFailureStatus,
    detail: validation.detail,
  };
}
