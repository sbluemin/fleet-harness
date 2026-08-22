import { eagerAnthropicRequestBody } from "../../anthropic/passthrough.js";
import {
  clampReasoningEffort,
  type ReasoningEffort,
} from "../../canonical/index.js";
import {
  reasoningEffortFromOutputConfig,
  type AnthropicMessagesRequest,
} from "../../anthropic/protocol.js";
import { KIMI_CODE_API_BASE_URL } from "../../models.js";

export const KIMI_MESSAGES_URL = `${KIMI_CODE_API_BASE_URL}/v1/messages`;

const KIMI_REASONING_EFFORTS = ["low", "high", "max"] as const satisfies readonly ReasoningEffort[];

/** K3 accepts three native effort tiers; normalize Claude Code's wider picker ladder. */
export function kimiRequestBody(body: AnthropicMessagesRequest, model: string): AnthropicMessagesRequest {
  const eagerBody = eagerAnthropicRequestBody(body, model);
  const effort = reasoningEffortFromOutputConfig(body.output_config);
  if (effort === undefined) {
    return eagerBody;
  }
  return {
    ...eagerBody,
    output_config: {
      ...body.output_config,
      effort: clampReasoningEffort(effort, KIMI_REASONING_EFFORTS, model),
    },
  };
}

/**
 * Kimi Anthropic-wire 요청 헤더.
 *
 * content-type/anthropic-version/x-api-key를 고정하고, anthropic-beta/user-agent를
 * 호출자 요청에서 그대로 전달한다.
 */
export function kimiAnthropicHeaders(
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
