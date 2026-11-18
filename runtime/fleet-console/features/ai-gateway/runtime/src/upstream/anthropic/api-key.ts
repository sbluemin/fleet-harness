/**
 * API 키(크레딧) 모델의 Anthropic passthrough 정책.
 *
 * 구독 경로(`native.ts`)는 호출자의 자격을 그대로 중계해 청구 주체를 호출자로 남긴다. 이 경로는 반대다:
 * 호출자(Claude Code Agent SDK 자식)는 구독 OAuth를 들고 있고, 그것은 **상류로 보내지 않는다**.
 * 대신 Console이 저장한 키를 `x-api-key`로 싣는다 — 그래서 청구가 구독 한도가 아니라 API 크레딧으로 간다.
 *
 * 진입점 표식(`user-agent`, 시스템 프롬프트의 billing 블록)은 건드리지 않는다. 크레딧이 Agent SDK 진입
 * (`sdk-ts`)에만 적용되는 것이 그 표식에 기대는 서버 판정이라(2026-11-18 지휘관 실측), 호출자가 보낸
 * 값을 그대로 두는 것이 이 공급자가 정직하게 성립하는 조건이다.
 */

/**
 * 구독 OAuth 호출자에게만 의미 있는 베타. 문서에 없는 OAuth 전용 값이고, 같은 SDK가 API 키로 직접
 * 붙을 때는 보내지 않는다(Agent SDK 0.3.322, 2026-11-18 지휘관 실측 — 그 호출이 크레딧에서 차감됐다).
 * 알 수 없는 베타 값은 400으로 거절될 수 있다(https://platform.claude.com/docs/en/api/beta-headers,
 * "Unexpected value(s) … for the `anthropic-beta` header"). 그래서 키 호출에는 싣지 않는다.
 */
const OAUTH_ONLY_BETA = "oauth-2025-04-20";

/**
 * 1M 컨텍스트 베타(`context-1m-2025-08-07`)는 **추가하지 않는다**. 구독 경로(`native.ts`)는 1M 모델에
 * 그것을 붙이지만, 이 카탈로그의 세 모델은 1M을 표준 가격으로 포함하는 5.5 세대라 베타가 필요 없다
 * (https://platform.claude.com/docs/en/about-claude/pricing "Long context pricing", 2026-11-18). 호출자가
 * 이미 실어 보낸 값은 보존된다.
 */

/**
 * 상류로 보낼 헤더. `authorization`은 절대 복사하지 않고 `x-api-key`는 호출자 값이 아니라 저장된 키다.
 * `anthropic-version`·`anthropic-beta`(OAuth 전용 값 제외)·`user-agent`는 호출자 값을 보존한다.
 */
export function anthropicApiKeyHeaders(
  requestHeaders: Readonly<Record<string, unknown>>,
  apiKey: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": typeof requestHeaders["anthropic-version"] === "string"
      ? requestHeaders["anthropic-version"]
      : "2023-06-01",
    "x-api-key": apiKey,
  };
  const userAgent = requestHeaders["user-agent"];
  if (typeof userAgent === "string") headers["user-agent"] = userAgent;
  const beta = requestHeaders["anthropic-beta"];
  if (typeof beta === "string") {
    const kept = beta.split(",").map((value) => value.trim()).filter((value) => value.length > 0 && value !== OAUTH_ONLY_BETA);
    if (kept.length > 0) headers["anthropic-beta"] = kept.join(",");
  }
  return headers;
}

/**
 * 상류로 보낼 본문: `model`을 카탈로그의 상류 id로 바꾸고 `speed`를 지운다. 속도는 항상 standard다
 * (생략 = standard, https://platform.claude.com/docs/en/build-with-claude/fast-mode) — Fast는 지원하지 않으며
 * 호출자가 어떤 이유로 `speed`를 실어 보내도 크레딧을 두 배 단가로 태우지 못하게 여기서 막는다.
 * 그 밖의 필드는 그대로 둔다.
 */
export function anthropicApiKeyBody<T extends object>(body: T, upstreamId: string): Omit<T, "speed"> & { model: string } {
  const { speed: _speed, ...rest } = body as T & { speed?: unknown };
  return { ...rest, model: upstreamId };
}
