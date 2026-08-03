import {
  KIMI_AUTH_PROVIDER_ID,
  KIMI_CODE_API_BASE_URL,
  KIMI_CODE_MODEL,
  OPENCODE_AUTH_PROVIDER_ID,
  OPENCODE_GO_API_BASE_URL,
  OPENCODE_GO_MODEL,
} from "@dotobokuri/core-ai-gateway";
import {
  isAuthValidationSuccess,
  validateAnthropicCompatibleApiKey,
  type AuthValidationFailureResult,
  type AuthValidationFailureStatus,
} from "@dotobokuri/core-infra";

// 접속 좌표(저장 provider id·base URL·검증 모델)는 core-ai-gateway가 소유한다.
// 여기서는 Admiral 표면을 유지하기 위해 그대로 재노출하고, 키 검증만 이 계층이 맡는다.
export {
  KIMI_AUTH_PROVIDER_ID,
  KIMI_CODE_API_BASE_URL,
  KIMI_CODE_MODEL,
  OPENCODE_AUTH_PROVIDER_ID,
  OPENCODE_GO_API_BASE_URL,
  OPENCODE_GO_MODEL,
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
