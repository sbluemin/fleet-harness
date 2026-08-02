import {
  KIMI_AUTH_PROVIDER_ID,
  KIMI_CODE_API_BASE_URL,
  KIMI_CODE_MODEL,
} from "@dotobokuri/core-ai-gateway";
import {
  isAuthValidationSuccess,
  validateAnthropicCompatibleApiKey,
  type AuthValidationFailureResult,
  type AuthValidationFailureStatus,
} from "@dotobokuri/core-infra";

// 접속 좌표(저장 provider id·base URL·검증 모델)는 core-ai-gateway가 소유한다.
// 여기서는 Admiral 표면을 유지하기 위해 그대로 재노출하고, 키 검증만 이 계층이 맡는다.
export { KIMI_AUTH_PROVIDER_ID, KIMI_CODE_API_BASE_URL, KIMI_CODE_MODEL };

export async function validateKimiAuthKey(
  apiKey: string,
): Promise<AuthValidationFailureResult | { readonly providerId: string; readonly status: "success" }> {
  const validation = await validateAnthropicCompatibleApiKey({
    providerId: KIMI_AUTH_PROVIDER_ID,
    apiKey,
    baseUrl: KIMI_CODE_API_BASE_URL,
    model: KIMI_CODE_MODEL,
  });
  if (isAuthValidationSuccess(validation)) {
    return { providerId: KIMI_AUTH_PROVIDER_ID, status: "success" };
  }
  return {
    providerId: KIMI_AUTH_PROVIDER_ID,
    status: validation.status as AuthValidationFailureStatus,
    detail: validation.detail,
  };
}
