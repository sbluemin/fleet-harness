import { eagerAnthropicRequestBody } from "../../../downstream/wire/anthropic-messages/passthrough.js";
import type { AnthropicMessagesRequest } from "../../../downstream/wire/anthropic-messages/protocol.js";

/**
 * OpenCode Go의 Anthropic-wire 요청 정책.
 *
 * Go의 Anthropic-wire 모델별 effort 수용 범위가 문서화돼 있지 않아, 미지의 upstream
 * 400을 피하기 위해 `output_config.effort`를 제거하고 나머지 output_config만 유지한다.
 */
export function opencodeRequestBody(
  body: AnthropicMessagesRequest,
  model: string,
): AnthropicMessagesRequest {
  const eagerBody = eagerAnthropicRequestBody(body, model);
  if (body.output_config === undefined) return eagerBody;
  const { effort: _effort, ...outputConfig } = body.output_config;
  const { output_config: _outputConfig, ...withoutOutputConfig } = eagerBody;
  return Object.keys(outputConfig).length > 0
    ? { ...withoutOutputConfig, output_config: outputConfig }
    : withoutOutputConfig;
}

/**
 * OpenCode Go Anthropic-wire 요청 헤더.
 *
 * content-type/anthropic-version/x-api-key를 고정하고, anthropic-beta/user-agent를
 * 호출자 요청에서 그대로 전달한다.
 */
export function opencodeAnthropicHeaders(
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
  for (const name of ["anthropic-beta", "user-agent"]) {
    const value = requestHeaders[name];
    if (typeof value === "string") headers[name] = value;
  }
  return headers;
}
