/**
 * Native Anthropic passthrough 정책.
 *
 * Anthropic 원문 모델은 canonical 번역 없이 요청 본문과 응답 스트림을 그대로 중계한다.
 * 이 모듈이 그 경로의 엔드포인트와 헤더 정책을 소유하고, 런타임은 본문/응답 펌핑만 담당한다.
 */

/** Native Anthropic Messages 엔드포인트. */
export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

/**
 * Native Anthropic passthrough 요청 헤더.
 *
 * content-type과 anthropic-version을 고정(호출자가 보낸 버전이 있으면 보존)하고,
 * authorization/x-api-key/anthropic-beta/user-agent를 호출자 요청에서 그대로 전달한다.
 * 자격증명을 교체하지 않는다 — 청구 주체는 호출자로 남는다.
 */
export function anthropicNativeHeaders(
  requestHeaders: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": typeof requestHeaders["anthropic-version"] === "string"
      ? requestHeaders["anthropic-version"]
      : "2023-06-01",
  };
  for (const name of ["authorization", "x-api-key", "anthropic-beta", "user-agent"]) {
    const value = requestHeaders[name];
    if (typeof value === "string") headers[name] = value;
  }
  return headers;
}
