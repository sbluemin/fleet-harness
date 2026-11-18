import { validateApiKeyByProbe, type AuthProbeRequest } from "../../auth/validation.js";
import type { AuthValidationResult } from "../../auth/types.js";
import { GEMINI_API_BASE_URL } from "./coordinates.js";
import { isInvalidApiKeyError } from "./stream.js";

/**
 * 키 검증 프로브가 부르는 모델 목록 경로. 추론 토큰을 쓰지 않는다. 2026-11-18 사령관 실측:
 * `x-goog-api-key`를 실은 `GET /v1beta/models`는 키가 유효하면 200이고 세 Gemini 4 모델이 보인다.
 */
export const GEMINI_MODELS_URL = `${GEMINI_API_BASE_URL}/models`;

/**
 * 키 검증 프로브: 모델 목록 조회가 추론 토큰 없이 키만 확인한다.
 *
 * 잘못된 키는 401이 아니라 **HTTP 400**으로 거절된다 — 2026-11-18 사령관이 가짜 키로 이 URL을
 * 직접 쳐서 본 응답: `{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.",
 * "status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo",
 * "reason":"API_KEY_INVALID",...}]}}`. 공식 api-errors 문서의 401 `authentication` 표는 Interactions API
 * 기준이라 v1beta REST에 맞지 않았다. 그래서 거절은 셋이다: 401, 403, 그리고 400 중
 * `details[].reason === "API_KEY_INVALID"`인 것. 그 밖의 400은 키 문제가 아니므로 거절로 읽지 않는다.
 */
export async function validateGeminiApiKey(request: {
  readonly providerId: string;
  readonly apiKey: string;
  readonly url?: string;
  readonly timeoutMs?: AuthProbeRequest["timeoutMs"];
}): Promise<AuthValidationResult> {
  // 빈 키는 요청 전에 막는다. 키 없는 요청의 응답은 키가 맞다는 증거가 아니다.
  if (request.apiKey.trim().length === 0) return { providerId: request.providerId, status: "unauthorized" };
  return validateApiKeyByProbe({ providerId: request.providerId, timeoutMs: request.timeoutMs }, async (signal) => {
    const response = await fetch(request.url ?? GEMINI_MODELS_URL, {
      method: "GET",
      headers: { accept: "application/json", "x-goog-api-key": request.apiKey },
      signal,
    });
    if (response.status !== 400) return response;
    // 400의 원인은 본문의 reason으로만 가려진다. 키 거절이면 공통 판정기가 읽는 401로 올린다.
    const parsed: unknown = await response.json().catch(() => undefined);
    return isInvalidApiKeyError(parsed) ? new Response(null, { status: 401 }) : new Response(null, { status: 400 });
  });
}
