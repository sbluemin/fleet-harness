import {
  isAuthValidationSuccess,
  validateAnthropicCompatibleApiKey,
  type AuthValidationFailureResult,
  type AuthValidationFailureStatus,
} from "@dotobokuri/core-infra";

// Keep the persisted provider id stable so existing Kimi keys remain usable
// after the retired direct Kimi backend is removed.
export const KIMI_AUTH_PROVIDER_ID = "Claude Code with Moonshot Kimi";
export const KIMI_CODE_API_BASE_URL = "https://api.kimi.com/coding";
export const KIMI_CODE_MODEL = "k3";

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
