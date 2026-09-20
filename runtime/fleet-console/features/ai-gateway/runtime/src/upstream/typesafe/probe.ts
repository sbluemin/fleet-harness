import { validateApiKeyByProbe, type AuthProbeRequest } from "../../auth/validation.js";
import type { AuthValidationResult } from "../../auth/types.js";
import { TYPESAFE_API_BASE_URL, TYPESAFE_MODELS_PATH } from "./coordinates.js";

/**
 * 키 검증 프로브. System One은 Anthropic Messages wire를 말하지 않으므로 그 검증을
 * 재사용할 수 없다. 대신 모델 목록 조회가 인증만 확인하고 추론 토큰을 전혀 쓰지
 * 않는다 — 유효한 키에 200, 잘못된 키에 401, 키가 없으면 403을 준다.
 */
export async function validateTypesafeApiKey(request: {
  readonly providerId: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: AuthProbeRequest["timeoutMs"];
}): Promise<AuthValidationResult> {
  const baseUrl = (request.baseUrl ?? TYPESAFE_API_BASE_URL).replace(/\/+$/, "");
  return validateApiKeyByProbe({ providerId: request.providerId, timeoutMs: request.timeoutMs }, (signal) =>
    fetch(`${baseUrl}${TYPESAFE_MODELS_PATH}`, {
      method: "GET",
      headers: { authorization: `Bearer ${request.apiKey}` },
      signal,
    }),
  );
}
