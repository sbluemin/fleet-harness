import type {
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicToolDefinition,
} from "./protocol.js";

/**
 * Anthropic 호환 passthrough upstream은 Fleet의 지연 로딩 도구 확장을 모른다.
 * 도구는 eager로 펼치고 tool_reference 결과 블록은 텍스트로 강등한다.
 *
 * Anthropic-wire passthrough 모델(Kimi, OpenCode Go native)과 번역 모델 공통의
 * 프로토콜 정규화로, provider 소유 본문 정책(opencodeRequestBody, kimiRequestBody)이
 * 이 위에서 구성된다.
 */
export function eagerAnthropicRequestBody(
  body: AnthropicMessagesRequest,
  model: string,
): AnthropicMessagesRequest {
  return {
    ...body,
    model,
    messages: body.messages.map(eagerAnthropicMessage),
    ...(body.tools === undefined ? {} : { tools: body.tools.map(eagerAnthropicTool) }),
  };
}

function eagerAnthropicTool(tool: AnthropicToolDefinition): AnthropicToolDefinition {
  if (!("input_schema" in tool)) return tool;
  const { defer_loading: _deferLoading, ...eagerTool } = tool;
  return eagerTool;
}

function eagerAnthropicMessage(message: AnthropicMessage): AnthropicMessage {
  if (typeof message.content === "string") return message;
  return {
    ...message,
    content: message.content.map((block) => {
      if (block.type !== "tool_result" || !Array.isArray(block.content)) return block;
      return {
        ...block,
        content: block.content.map((result) => {
          if (result.type !== "tool_reference") return result;
          const toolName = typeof result.tool_name === "string" && result.tool_name.length > 0
            ? result.tool_name
            : "(invalid reference)";
          return { type: "text" as const, text: `Tool available: ${toolName}` };
        }),
      };
    }),
  };
}
