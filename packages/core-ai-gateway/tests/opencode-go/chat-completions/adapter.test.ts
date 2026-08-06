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
} from "../../../src/index.js";
import type { CanonicalResponseEvent, CanonicalResponseRequest } from "../../../src/index.js";

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

  it("replays reasoning only for DeepSeek V4 assistant tool turns", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    await adapter(fetchMock).stream(request({
      input: [
        { type: "message", role: "user", content: "go" },
        {
          type: "function_call",
          call_id: "call-a",
          name: "ToolA",
          arguments: "{}",
          reasoning_content: "Need the tool.",
        },
        { type: "function_call_output", call_id: "call-a", output: "done" },
        {
          type: "message",
          role: "assistant",
          content: "finished",
          reasoning_content: "Interpreting the result.",
        },
      ],
    }), { apiKey: "k" });

    const deepSeekBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(deepSeekBody.messages).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        reasoning_content: "Need the tool.",
        tool_calls: [{ id: "call-a", type: "function", function: { name: "ToolA", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call-a", content: "done" },
      { role: "assistant", content: "finished", reasoning_content: "Interpreting the result." },
    ]);

    fetchMock.mockClear();
    await adapter(fetchMock).stream(request({
      model: "kimi-k3",
      input: [{
        type: "message",
        role: "assistant",
        content: "finished",
        reasoning_content: "Do not replay globally.",
      }],
    }), { apiKey: "k" });
    const kimiBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(kimiBody.messages).toEqual([{ role: "assistant", content: "finished" }]);
  });

  it("folds same-turn trailing assistant text into the tool_calls message itself", async () => {
    // Chat 와이어의 정식 표현: 한 assistant 메시지가 content와 tool_calls를 함께 싣는다.
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    await adapter(fetchMock).stream(request({
      input: [
        { type: "message", role: "user", content: "go" },
        { type: "function_call", call_id: "call-a", name: "ToolA", arguments: "{}" },
        { type: "message", role: "assistant", content: "calling now" },
        { type: "function_call_output", call_id: "call-a", output: "done" },
      ],
    }), { apiKey: "k" });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(body.messages).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "calling now",
        tool_calls: [{ id: "call-a", type: "function", function: { name: "ToolA", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call-a", content: "done" },
    ]);
  });

  it("defers leading user text until after its tool output, preserving conversation order", async () => {
    // user가 tool_result와 함께 보낸 텍스트는 결과 직후가 의미상 제자리다 — 호출보다
    // 앞으로 끌어올리면 대화 순서가 뒤집힌다.
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    await adapter(fetchMock).stream(request({
      input: [
        { type: "message", role: "user", content: "go" },
        { type: "function_call", call_id: "call-a", name: "ToolA", arguments: "{}" },
        { type: "message", role: "user", content: "here you go" },
        { type: "function_call_output", call_id: "call-a", output: "done" },
        { type: "message", role: "user", content: "next question" },
      ],
    }), { apiKey: "k" });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(body.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "go"],
      ["assistant", null],
      ["tool", "done"],
      ["user", "here you go"],
      ["user", "next question"],
    ]);
  });

  it("maps user image parts for non-DeepSeek models and folds assistant parts to text", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    await adapter(fetchMock).stream(request({
      model: "kimi-k3",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "look:" },
            { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "original" },
          ],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "input_text", text: "seen" }],
        },
      ],
    }), { apiKey: "k" });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(body.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look:" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AA==", detail: "high" } },
      ],
    });
    expect(body.messages[1]).toEqual({ role: "assistant", content: "seen" });
  });

  it.each(["deepseek-v4-flash", "deepseek-v4-pro"])(
    "folds image parts to text on the OpenCode wrapper for %s",
    async (model) => {
      const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
      await new OpencodeGoChatCompletionsAdapter({ fetch: fetchMock }).stream(request({
        model,
        instructions: "system",
        input: [{
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "inspect this" },
            { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "auto" },
          ],
        }],
      }), { apiKey: "k" });

      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
        messages: Array<Record<string, unknown>>;
      };
      expect(body.messages[1]).toEqual({ role: "user", content: "inspect this" });
      expect(JSON.stringify(body.messages)).not.toContain("image_url");
    },
  );

  it.each([
    ["generic adapter", (fetchMock: typeof fetch) => adapter(fetchMock)],
    ["legacy subclass", (fetchMock: typeof fetch) => new LegacyChatAdapterSubclass({
      url: CHAT_URL,
      fetch: fetchMock,
    })],
  ])("preserves deepseek-v4 image parts on the %s", async (_label, createAdapter) => {
    // 레거시 공개 어댑터와 기존 subclass의 HEAD 동작: user image part를 image_url로 보존.
    // subclass의 같은 이름 private method는 provider 정책 hook가 아니며 호출되면 안 된다.
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    await createAdapter(fetchMock).stream(request({
      model: "deepseek-v4-flash",
      input: [{
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "inspect this" },
          { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "auto" },
        ],
      }],
    }), { apiKey: "k" });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(body.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "inspect this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AA==", detail: "auto" } },
      ],
    });
  });

  it("keeps DeepSeek V4 reasoning replay on the OpenCode wrapper while folding images", async () => {
    // reasoning replay는 레거시 generic HEAD 동작으로 래퍼도 상속한다 — 이미지 폴딩만
    // OpenCode 래퍼에 국한되고 reasoning 재생은 제거되지 않는다.
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    await new OpencodeGoChatCompletionsAdapter({ fetch: fetchMock }).stream(request({
      model: "deepseek-v4-flash",
      input: [
        { type: "message", role: "user", content: "go" },
        {
          type: "function_call",
          call_id: "call-a",
          name: "ToolA",
          arguments: "{}",
          reasoning_content: "Need the tool.",
        },
        { type: "function_call_output", call_id: "call-a", output: "done" },
      ],
    }), { apiKey: "k" });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(body.messages).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        reasoning_content: "Need the tool.",
        tool_calls: [{ id: "call-a", type: "function", function: { name: "ToolA", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call-a", content: "done" },
    ]);
  });
});

describe("chat completions stream translation", () => {
  it("translates reasoning_content into canonical reasoning events", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse(
      chunk({ id: "c-reason", model: "deepseek-v4-flash", choices: [{ index: 0, delta: { reasoning_content: "Inspecting " } }] }),
      chunk({ id: "c-reason", model: "deepseek-v4-flash", choices: [{ index: 0, delta: { reasoning_content: "the repository." } }] }),
      chunk({ id: "c-reason", model: "deepseek-v4-flash", choices: [{ index: 0, delta: { content: "Done" } }] }),
      "data: [DONE]\n\n",
    ));
    const response = await adapter(fetchMock).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected ok");
    const events = await collect(response.events);

    expect(events.filter((event) => event.type === "response.reasoning_summary_text.delta")).toEqual([
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "chat_message_0_reasoning",
        output_index: 0,
        delta: "Inspecting ",
      },
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "chat_message_0_reasoning",
        output_index: 0,
        delta: "the repository.",
      },
    ]);
  });

  it("translates text chunks into canonical text events with final usage", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse(
      ": keep-alive\n\n",
      chunk({ id: "c1", model: "deepseek-v4-flash", choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] }),
      chunk({ id: "c1", model: "deepseek-v4-flash", choices: [{ index: 0, delta: { content: "lo" } }] }),
      chunk({
        id: "c1",
        model: "deepseek-v4-flash",
        choices: [],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 5,
          total_tokens: 16,
          prompt_tokens_details: { cached_tokens: 4 },
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      }),
      "data: [DONE]\n\n",
    ));
    const response = await adapter(fetchMock).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected ok");
    const events = await collect(response.events);

    expect(events[0]).toEqual({
      type: "response.created",
      response: { id: "c1", model: "deepseek-v4-flash", usage: null },
    });
    expect(events.filter((event) => event.type === "response.output_text.delta").map((event) => (
      event.type === "response.output_text.delta" ? event.delta : ""
    ))).toEqual(["Hel", "lo"]);
    expect(events.at(-2)).toMatchObject({ type: "response.output_text.done", text: "Hello" });
    expect(events.at(-1)).toEqual({
      type: "response.completed",
      response: {
        id: "c1",
        model: "deepseek-v4-flash",
        usage: {
          input_tokens: 11,
          output_tokens: 5,
          cached_input_tokens: 4,
          reasoning_output_tokens: 2,
          total_tokens: 16,
        },
      },
    });
  });

  it("assembles fragmented tool calls and emits them whole, never as argument deltas", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse(
      chunk({ id: "c2", model: "glm-5.2", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-x", function: { name: "Read", arguments: "{\"pa" } }] } }] }),
      chunk({ id: "c2", model: "glm-5.2", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "th\":\"a.ts\"}" } }] } }] }),
      chunk({ id: "c2", model: "glm-5.2", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
      "data: [DONE]\n\n",
    ));
    const response = await adapter(fetchMock).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected ok");
    const events = await collect(response.events);

    expect(events.some((event) => event.type === "response.function_call_arguments.delta")).toBe(false);
    // added→arguments.done→done 3종: 스트리밍 변환과 비스트리밍 collect가 모두 소비한다.
    const item = {
      id: "call-x",
      type: "function_call" as const,
      call_id: "call-x",
      name: "Read",
      arguments: "{\"path\":\"a.ts\"}",
    };
    expect(events.filter((event) => event.type.startsWith("response.output_item")
      || event.type === "response.function_call_arguments.done")).toEqual([
      { type: "response.output_item.added", output_index: 1, item: { ...item, arguments: "" } },
      {
        type: "response.function_call_arguments.done",
        item_id: "call-x",
        output_index: 1,
        arguments: "{\"path\":\"a.ts\"}",
      },
      { type: "response.output_item.done", output_index: 1, item },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      // usage 청크가 없는 백엔드는 0-usage로 완결한다 — 하류 message_delta의 필수 필드.
      response: { usage: { input_tokens: 0, output_tokens: 0 } },
    });
  });

  it("surfaces an upstream error payload as a canonical error event", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse(
      chunk({ error: { type: "server_error", message: "boom" } }),
    ));
    const response = await adapter(fetchMock).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected ok");
    const events = await collect(response.events);
    expect(events).toEqual([{ type: "error", error: { type: "server_error", message: "boom" } }]);
  });

  it("returns non-2xx bodies as a failed adapter response", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{\"error\":{}}", { status: 402 }));
    const response = await adapter(fetchMock).stream(request(), { apiKey: "k" });
    expect(response.ok).toBe(false);
    expect(response.status).toBe(402);
  });
});

describe("opencode go wire routing", () => {
  it("defaults an undeclared wire to anthropic", () => {
    expect(opencodeGoWire({})).toBe("anthropic");
    expect(opencodeGoWire({ wire: "responses" })).toBe("responses");
  });

  it("builds the matching adapter and endpoint per translated wire", () => {
    expect(createOpencodeGoAdapter("responses")).toBeInstanceOf(OpencodeGoResponsesAdapter);
    expect(createOpencodeGoAdapter("chat-completions")).toBeInstanceOf(OpencodeGoChatCompletionsAdapter);
    expect(OPENCODE_GO_RESPONSES_URL).toBe("https://opencode.ai/zen/go/v1/responses");
    expect(OPENCODE_GO_CHAT_COMPLETIONS_URL).toBe("https://opencode.ai/zen/go/v1/chat/completions");
  });

  it("sends responses-wire requests to the Go responses endpoint with Bearer auth", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    const goAdapter = createOpencodeGoAdapter("responses", { fetch: fetchMock });
    await goAdapter.stream(request({ model: "gpt-5.6-luna" }), { apiKey: "sk-go" });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(OPENCODE_GO_RESPONSES_URL);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-go");
  });

  it("sends chat-wire requests to the Go chat completions endpoint with Bearer auth", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    const goAdapter = createOpencodeGoAdapter("chat-completions", { fetch: fetchMock });
    await goAdapter.stream(request({ model: "deepseek-v4-flash" }), { apiKey: "sk-go" });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(OPENCODE_GO_CHAT_COMPLETIONS_URL);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-go");
  });

  it("validates explicit zero limits on the chat-completions wrapper", () => {
    expect(() => new OpencodeGoChatCompletionsAdapter({ maxBodyBytes: 0 })).toThrow(TypeError);
    expect(() => new OpencodeGoChatCompletionsAdapter({ idleTimeoutMs: 0 })).toThrow(TypeError);
  });
});
