import { describe, expect, it, vi } from "vitest";

import {
  OPENCODE_GO_CHAT_COMPLETIONS_URL,
  OPENCODE_GO_RESPONSES_URL,
  OpenAIChatCompletionsAdapter,
  OpenAIChatCompletionsAdapterOptions,
  OpencodeGoChatCompletionsAdapter,
  OpencodeGoResponsesAdapter,
  createOpencodeGoAdapter,
  opencodeGoWire,
} from "../../../../src/index.js";
import type { CanonicalResponseEvent, CanonicalResponseRequest } from "../../../../src/index.js";
import { wireLogFixture } from "../../../helpers/wire-log.js";

const CHAT_URL = "https://chat.example/v1/chat/completions";

function adapter(
  fetchImpl: typeof fetch,
  options: Partial<OpenAIChatCompletionsAdapterOptions> = {},
): OpenAIChatCompletionsAdapter {
  return new OpenAIChatCompletionsAdapter({ url: CHAT_URL, fetch: fetchImpl, ...options });
}

class LegacyChatAdapterSubclass extends OpenAIChatCompletionsAdapter {
  // 기존 소비자는 같은 이름의 private 구현 세부사항을 자유롭게 가질 수 있다.
  // Provider 정책 hook로 승격하면 이 합법적인 subclass가 TS2415로 깨진다.
  private supportsImageInput(_model: string): boolean {
    return false;
  }
}

function request(overrides: Partial<CanonicalResponseRequest> = {}): CanonicalResponseRequest {
  return {
    model: "deepseek-v4-flash",
    input: [{ type: "message", role: "user", content: "hi" }],
    stream: true,
    ...overrides,
  };
}

function sse(...frames: string[]): Response {
  return new Response(frames.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function chunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function collect(events: AsyncIterable<CanonicalResponseEvent>): Promise<CanonicalResponseEvent[]> {
  const out: CanonicalResponseEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("chat completions request translation", () => {
  it("threads instructions, tool calls, and tool replies through chat roles", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    await adapter(fetchMock).stream(request({
      instructions: "Be terse.",
      input: [
        { type: "message", role: "developer", content: "House rules." },
        { type: "message", role: "user", content: "run both tools" },
        { type: "function_call", call_id: "call-a", name: "ToolA", arguments: "{\"x\":1}" },
        { type: "function_call", call_id: "call-b", name: "ToolB", arguments: "{}" },
        { type: "function_call_output", call_id: "call-a", output: "alpha", is_error: true, tool_references: ["ToolB"] },
        { type: "function_call_output", call_id: "call-b", output: "beta" },
        { type: "message", role: "assistant", content: "done" },
      ],
      tools: [{
        type: "function",
        name: "ToolA",
        description: "does A",
        parameters: { type: "object", properties: {} },
        defer_loading: true,
      }],
      tool_choice: { type: "function", name: "ToolA" },
      parallel_tool_calls: true,
      max_output_tokens: 128,
      reasoning: { summary: "auto", effort: "high" },
    }), { apiKey: "k" });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.messages).toEqual([
      { role: "system", content: "Be terse." },
      { role: "system", content: "House rules." },
      { role: "user", content: "run both tools" },
      {
        role: "assistant",
        content: null,
        // 연속 function_call은 하나의 assistant 메시지로 합쳐져 tool 응답 인접성을 지킨다.
        tool_calls: [
          { id: "call-a", type: "function", function: { name: "ToolA", arguments: "{\"x\":1}" } },
          { id: "call-b", type: "function", function: { name: "ToolB", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call-a", content: "alpha" },
      { role: "tool", tool_call_id: "call-b", content: "beta" },
      { role: "assistant", content: "done" },
    ]);
    expect(body.tools).toEqual([{
      type: "function",
      function: { name: "ToolA", description: "does A", parameters: { type: "object", properties: {} } },
    }]);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "ToolA" } });
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.max_tokens).toBe(128);
    expect(body.stream_options).toEqual({ include_usage: true });
    // Chat Completions에는 이식 가능한 reasoning 파라미터가 없다 — 와이어에 실리면 안 된다.
    expect(body).not.toHaveProperty("reasoning");
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer k");
  });

  it("omits tools only for the exact Claude Code Suggestion Mode turn on OpenCode", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    const tools: CanonicalResponseRequest["tools"] = [{
      type: "function",
      name: "Read",
      parameters: { type: "object", properties: {} },
    }];
    const suggestion = [
      "[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]",
      "Keep it short.",
      "Reply with ONLY the suggestion, no quotes or explanation.",
    ].join("\n");

    await new OpencodeGoChatCompletionsAdapter({ fetch: fetchMock }).stream(request({
      input: [{ type: "message", role: "user", content: suggestion }],
      tools,
      tool_choice: "auto",
      parallel_tool_calls: true,
    }), { apiKey: "k" });
    const optimized = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(optimized).not.toHaveProperty("tools");
    expect(optimized).not.toHaveProperty("tool_choice");
    expect(optimized).not.toHaveProperty("parallel_tool_calls");

    fetchMock.mockClear();
    await new OpencodeGoChatCompletionsAdapter({ fetch: fetchMock }).stream(request({
      input: [{ type: "message", role: "user", content: suggestion }],
      tools,
      tool_choice: "none",
    }), { apiKey: "k" });
    const disabledTools = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(disabledTools).not.toHaveProperty("tools");
    expect(disabledTools).not.toHaveProperty("tool_choice");

    fetchMock.mockClear();
    await new OpencodeGoChatCompletionsAdapter({ fetch: fetchMock }).stream(request({
      input: [{
        type: "message",
        role: "user",
        content: [
          "[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]",
          "Reply with ONLY the suggestion.",
        ].join("\n"),
      }],
      tools,
      tool_choice: "auto",
    }), { apiKey: "k" });
    const legacyPrompt = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(legacyPrompt).not.toHaveProperty("tools");
    expect(legacyPrompt).not.toHaveProperty("tool_choice");

    fetchMock.mockClear();
    await new OpencodeGoChatCompletionsAdapter({ fetch: fetchMock }).stream(request({
      input: [{ type: "message", role: "user", content: `${suggestion}\nPlease use Read.` }],
      tools,
    }), { apiKey: "k" });
    const nearMatch = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(nearMatch).toHaveProperty("tools");

    fetchMock.mockClear();
    await new OpencodeGoChatCompletionsAdapter({ fetch: fetchMock }).stream(request({
      input: [{ type: "message", role: "user", content: suggestion }],
      tools,
      tool_choice: { type: "function", name: "Read" },
    }), { apiKey: "k" });
    const forcedTool = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(forcedTool).toHaveProperty("tools");
    expect(forcedTool).toHaveProperty("tool_choice");

    fetchMock.mockClear();
    await new OpencodeGoChatCompletionsAdapter({ fetch: fetchMock }).stream(request({
      input: [{ type: "message", role: "user", content: suggestion }],
      tools,
      tool_choice: "required",
    }), { apiKey: "k" });
    const requiredTool = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(requiredTool).toHaveProperty("tools");
    expect(requiredTool.tool_choice).toBe("required");

    fetchMock.mockClear();
    await adapter(fetchMock).stream(request({
      input: [{ type: "message", role: "user", content: suggestion }],
      tools,
    }), { apiKey: "k" });
    const generic = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(generic).toHaveProperty("tools");
  });
});

describe("opencode go wire routing", () => {

  it("sends chat-wire requests to the Go chat completions endpoint with Bearer auth", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    const goAdapter = createOpencodeGoAdapter("chat-completions", { fetch: fetchMock });
    const input: CanonicalResponseRequest["input"] = [{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Describe this image." },
        { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
      ],
    }];
    await goAdapter.stream(request({ model: "deepseek-v4-flash-vision-exp", input }), { apiKey: "sk-go" });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(OPENCODE_GO_CHAT_COMPLETIONS_URL);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-go");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "deepseek-v4-flash-vision-exp",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this image." },
          { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
        ],
      }],
    });

    await goAdapter.stream(request({ model: "deepseek-v4-flash", input }), { apiKey: "sk-go" });
    const textOnlyBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(textOnlyBody.model).toBe("deepseek-v4-flash");
    expect(JSON.stringify(textOnlyBody.messages)).not.toContain("image_url");
  });
});

describe("chat completions undeclared argument pruning", () => {
  function closedSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        claim: { type: "string" },
        source: { type: "string" },
        quote: { type: "string" },
      },
      required: ["claim", "source", "quote"],
      additionalProperties: false,
    };
  }

  function tool(parameters: Record<string, unknown>, name = "Record") {
    return { type: "function" as const, name, description: "records one finding", parameters };
  }

  function toolCall(args: string, name = "Record"): Response {
    return sse(
      chunk({ id: "c", model: "deepseek-v4-flash", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", function: { name, arguments: args } }] } }] }),
      chunk({ id: "c", model: "deepseek-v4-flash", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
      "data: [DONE]\n\n",
    );
  }

  async function emittedArguments(
    args: string,
    parameters: Record<string, unknown>,
    calledName = "Record",
  ): Promise<string> {
    const fetchMock = vi.fn<typeof fetch>(async () => toolCall(args, calledName));
    // Pruning is bound to the provider wrapper, never the public generic class.
    const response = await new OpencodeGoChatCompletionsAdapter({ fetch: fetchMock }).stream(
      request({ tools: [tool(parameters)] }),
      { apiKey: "k" },
    );
    if (!response.ok) throw new Error("expected ok");
    const events = await collect(response.events);
    const done = events.find((event) => event.type === "response.function_call_arguments.done");
    if (done?.type !== "response.function_call_arguments.done") throw new Error("no arguments.done");
    const item = events.find((event) => event.type === "response.output_item.done");
    if (item?.type !== "response.output_item.done") throw new Error("no output_item.done");
    if (item.item.type !== "function_call") throw new Error("expected a function_call item");
    // 두 이벤트가 갈라지면 하류가 어느 쪽을 읽느냐에 따라 인자가 달라진다.
    expect(item.item.arguments).toBe(done.arguments);
    return done.arguments;
  }

  it("drops a key the closed schema never declared", async () => {
    // The measured OpenCode Zen behaviour: `strict: true` is accepted and ignored, so the
    // model still appends an empty-string key no schema keyword allows.
    expect(await emittedArguments(
      "{\"claim\":\"c\",\"source\":\"s\",\"quote\":\"q\",\"quote_unused\":\"\"}",
      closedSchema(),
    )).toBe("{\"claim\":\"c\",\"source\":\"s\",\"quote\":\"q\"}");
  });
});
