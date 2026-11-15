import { validateApiKeyByProbe, type AuthProbeRequest } from "../../auth/validation.js";
import type { AuthValidationResult } from "../../auth/types.js";
import { OPENCODE_GO_MODELS_URL } from "./coordinates.js";
import { opencodeSessionHeaders } from "./session.js";

/**
 * 키 검증 프로브. 이 공급자의 범위 안에는 Anthropic wire 모델이 없으므로 예전의 1토큰 생성
 * 프로브를 쓸 수 없다. 대신 모델 목록 조회가 추론 토큰 없이 키만 확인한다.
 *
 * 목록은 공개라 키가 없으면 200이다. 그래서 이 프로브는 언제나 키를 싣고, 키를 실은 요청의
 * 401·403만 거절로 읽는다 — 빈 키는 요청 전에 막는다(2026-11-15 실측: 가짜·만료 키 401).
 */
export async function validateOpencodeGoApiKey(request: {
  readonly providerId: string;
  readonly apiKey: string;
  readonly url?: string;
  readonly timeoutMs?: AuthProbeRequest["timeoutMs"];
}): Promise<AuthValidationResult> {
  // 키 없는 목록 조회는 공개 200이라 무엇도 증명하지 않는다. 요청을 보내지 않고 거절한다.
  if (request.apiKey.trim().length === 0) return { providerId: request.providerId, status: "unauthorized" };
  return validateApiKeyByProbe({ providerId: request.providerId, timeoutMs: request.timeoutMs }, (signal) =>
    fetch(request.url ?? OPENCODE_GO_MODELS_URL, {
      method: "GET",
      headers: {
        ...opencodeSessionHeaders(undefined),
        accept: "application/json",
        authorization: `Bearer ${request.apiKey}`,
      },
      signal,
    }),
  );
}
