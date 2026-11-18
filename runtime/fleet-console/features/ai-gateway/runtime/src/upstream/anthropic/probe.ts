import { validateApiKeyByProbe, type AuthProbeRequest } from "../../auth/validation.js";
import type { AuthValidationResult } from "../../auth/types.js";
import { ANTHROPIC_API_BASE_URL } from "./coordinates.js";

/**
 * 키 검증 프로브가 부르는 모델 목록 경로. 추론 토큰을 쓰지 않으므로 크레딧을 소모하지 않는다.
 * 공식 문서(https://platform.claude.com/docs/en/api/errors, 2026-11-18 열람): 잘못된·폐기된 키는
 * 401 `authentication_error`, 권한 없는 키는 403 `permission_error`다 — 공통 판정기가 그대로 읽는다.
 */
export const ANTHROPIC_MODELS_URL = `${ANTHROPIC_API_BASE_URL}/v1/models`;

export async function validateAnthropicApiKey(request: {
  readonly providerId: string;
  readonly apiKey: string;
  readonly url?: string;
  readonly timeoutMs?: AuthProbeRequest["timeoutMs"];
}): Promise<AuthValidationResult> {
  // 빈 키는 요청 전에 막는다. 키 없는 요청의 응답은 키가 맞다는 증거가 아니다.
  if (request.apiKey.trim().length === 0) return { providerId: request.providerId, status: "unauthorized" };
  return validateApiKeyByProbe({ providerId: request.providerId, timeoutMs: request.timeoutMs }, (signal) =>
    fetch(request.url ?? ANTHROPIC_MODELS_URL, {
      method: "GET",
      headers: { accept: "application/json", "x-api-key": request.apiKey, "anthropic-version": "2023-06-01" },
      signal,
    }));
}
