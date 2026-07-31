import { describe, expect, it, vi } from "vitest";
import {
  AnthropicMessagesGateway,
  DEFAULT_OPENAI_MODEL,
  OPENAI_RESPONSES_URL,
  OpenAIResponsesAdapter,
  UpstreamBodyLimitError,
  UpstreamIdleTimeoutError,
  encodeAnthropicSse,
  translateAnthropicRequest
} from "../src/index.js";
import type {
  AnthropicMessagesRequest,
  CanonicalResponseEvent,
  FetchLike
} from "../src/index.js";

describe("Anthropic request translation", () => {
  it("maps system text blocks and tools into the OpenAI Responses subset", () => {
    const request: AnthropicMessagesRequest = {
      model: "claude-sonnet-4-6",
      system: [
        { type: "text", text: "You are a coding agent." },
        { type: "text", text: "Work carefully.", cache_control: { type: "ephemeral" } }
      ],
      messages: [{ role: "user", content: "Inspect the repository." }],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"]
          }
        }
      ],
      metadata: { user_id: "user-1", ignored_number: 42 },
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      context_management: { edits: [] },
      stream: true
    };

    expect(translateAnthropicRequest(request)).toEqual({
      model: DEFAULT_OPENAI_MODEL,
      input: [{ type: "message", role: "user", content: "Inspect the repository." }],
      instructions: "You are a coding agent.\n\nWork carefully.",
      tools: [
        {
          type: "function",
          name: "read_file",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"]
          }
        }
      ],
      max_output_tokens: 4096,
      metadata: { user_id: "user-1" },
      stream: true
    });
  });

  it("maps a second-turn tool_result back to the preserved function call id", () => {
    const request: AnthropicMessagesRequest = {
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll inspect it." },
            {
              type: "tool_use",
              id: "call_preserved",
              name: "read_file",
              input: { path: "README.md" }
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_preserved",
              content: [{ type: "text", text: "# Fleet" }]
            }
          ]
        }
      ],
      max_tokens: 1024,
      stream: true
    };

    expect(translateAnthropicRequest(request).input).toEqual([
      { type: "message", role: "assistant", content: "I'll inspect it." },
      {
        type: "function_call",
        call_id: "call_preserved",
        name: "read_file",
        arguments: '{"path":"README.md"}'
      },
      {
        type: "function_call_output",
        call_id: "call_preserved",
        output: "# Fleet"
      }
    ]);
  });
});

describe("Anthropic SSE encoding", () => {
  it("emits the complete Anthropic text-turn sequence", async () => {
    const events = iterable<CanonicalResponseEvent>([
      {
        type: "response.created",
        response: {
          id: "resp_text",
          model: "gpt-5.5",
          usage: { input_tokens: 12, output_tokens: 0 }
        }
      },
      {
        type: "response.content_part.added",
        item_id: "msg_text",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "" }
      },
      {
        type: "response.output_text.delta",
        item_id: "msg_text",
        output_index: 0,
        content_index: 0,
        delta: "Hello"
      },
      {
        type: "response.output_text.delta",
        item_id: "msg_text",
        output_index: 0,
        content_index: 0,
        delta: " there"
      },
      {
        type: "response.output_text.done",
        item_id: "msg_text",
        output_index: 0,
        content_index: 0,
        text: "Hello there"
      },
      {
        type: "response.completed",
        response: {
          id: "resp_text",
          model: "gpt-5.5",
          usage: { input_tokens: 12, output_tokens: 2 }
        }
      }
    ]);

    const frames = parseSse(await collectBody(encodeAnthropicSse(events)));

    expect(frames.map((frame) => frame.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop"
    ]);
    expect(frames[0]?.data).toMatchObject({
      type: "message_start",
      message: { id: "resp_text", model: "gpt-5.5", usage: { input_tokens: 12 } }
    });
    expect(frames[5]?.data).toEqual({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 }
    });
  });
});

describe("OpenAI Responses adapter", () => {
  it("streams function-call arguments into Anthropic tool_use deltas with the call id intact", async () => {
    const upstreamSse = [
      frame("response.created", {
        type: "response.created",
        response: { id: "resp_tool", model: "gpt-5.5", usage: null }
      }),
      frame("response.output_item.added", {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_internal", summary: [] }
      }),
      frame("response.output_item.added", {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          type: "function_call",
          id: "fc_internal",
          call_id: "call_preserved",
          name: "read_file",
          arguments: ""
        }
      }),
      frame("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: "fc_internal",
        output_index: 1,
        delta: '{"path"'
      }),
      frame("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: "fc_internal",
        output_index: 1,
        delta: ':"README.md"}'
      }),
      frame("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: "fc_internal",
        output_index: 1,
        arguments: '{"path":"README.md"}'
      }),
      frame("response.output_item.done", {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "function_call",
          id: "fc_internal",
          call_id: "call_preserved",
          name: "read_file",
          arguments: '{"path":"README.md"}'
        }
      }),
      frame("response.completed", {
        type: "response.completed",
        response: {
          id: "resp_tool",
          model: "gpt-5.5",
          usage: { input_tokens: 25, output_tokens: 8 }
        }
      })
    ].join("");
    const fetchMock = vi.fn<FetchLike>(async () => sseResponse(upstreamSse));
    const adapter = new OpenAIResponsesAdapter({ fetch: fetchMock });
    const result = await adapter.stream(
      {
        model: "gpt-5.5",
        input: [{ type: "message", role: "user", content: "Read README.md" }],
        stream: true
      },
      { apiKey: "injected-key" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected a successful stream");
    }
    const frames = parseSse(await collectBody(encodeAnthropicSse(result.events)));
    const start = frames.find((item) => item.event === "content_block_start");
    const deltas = frames.filter((item) => item.event === "content_block_delta");
    const messageDelta = frames.find((item) => item.event === "message_delta");

    expect(start?.data).toMatchObject({
      content_block: {
        type: "tool_use",
        id: "call_preserved",
        name: "read_file",
        input: {}
      }
    });
    expect(
      deltas.map((item) => (item.data.delta as { partial_json: string }).partial_json).join("")
    ).toBe('{"path":"README.md"}');
    expect(messageDelta?.data).toMatchObject({ delta: { stop_reason: "tool_use" } });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(OPENAI_RESPONSES_URL);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer injected-key");
  });

  it("bounds the total upstream stream body size", async () => {
    const adapter = new OpenAIResponsesAdapter({
      fetch: async () => sseResponse(frame("response.created", {
        type: "response.created",
        response: { id: "too_large", model: "gpt-5.5", usage: null }
      })),
      maxBodyBytes: 16
    });
    const result = await adapter.stream(
      { model: "gpt-5.5", input: [], stream: true },
      { apiKey: "key" }
    );
    if (!result.ok) {
      throw new Error("expected a successful HTTP response");
    }

    await expect(collectEvents(result.events)).rejects.toBeInstanceOf(UpstreamBodyLimitError);
  });

  it("cancels a stream that exceeds the idle timeout", async () => {
    const adapter = new OpenAIResponsesAdapter({
      fetch: async () =>
        new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        }),
      idleTimeoutMs: 20
    });
    const result = await adapter.stream(
      { model: "gpt-5.5", input: [], stream: true },
      { apiKey: "key" }
    );
    if (!result.ok) {
      throw new Error("expected a successful HTTP response");
    }

    await expect(collectEvents(result.events)).rejects.toBeInstanceOf(UpstreamIdleTimeoutError);
  });

  it("cancels an in-flight stream through the caller abort signal", async () => {
    const controller = new AbortController();
    const adapter = new OpenAIResponsesAdapter({
      fetch: async () =>
        new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        }),
      idleTimeoutMs: 10_000
    });
    const result = await adapter.stream(
      { model: "gpt-5.5", input: [], stream: true },
      { apiKey: "key", signal: controller.signal }
    );
    if (!result.ok) {
      throw new Error("expected a successful HTTP response");
    }

    controller.abort(new Error("cancelled by caller"));
    await expect(collectEvents(result.events)).rejects.toThrow("cancelled by caller");
  });
});

describe("upstream errors", () => {
  it("maps an OpenAI error to Anthropic shape while preserving its HTTP status", async () => {
    const adapter = new OpenAIResponsesAdapter({
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: { type: "rate_limit_error", message: "Retry after a moment" }
          }),
          { status: 429, headers: { "retry-after": "2" } }
        )
    });
    const gateway = new AnthropicMessagesGateway(adapter);
    const response = await gateway.stream(baseRequest(), { apiKey: "key" });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(JSON.parse(await collectBody(response.body))).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "Retry after a moment" }
    });
  });

  it("forwards an already-Anthropic upstream error body byte-for-byte", async () => {
    const raw =
      '{ "type": "error", "error": { "type": "overloaded_error", "message": "Busy" } }\n';
    const adapter = new OpenAIResponsesAdapter({
      fetch: async () => new Response(raw, { status: 529 })
    });
    const response = await new AnthropicMessagesGateway(adapter).stream(baseRequest(), {
      apiKey: "key"
    });

    expect(response.status).toBe(529);
    expect(await collectBody(response.body)).toBe(raw);
  });
});

function baseRequest(): AnthropicMessagesRequest {
  return {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "Hello" }],
    max_tokens: 128,
    stream: true
  };
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

function iterable<T>(values: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* values;
    }
  };
}

async function collectBody(body: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of body) {
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

async function collectEvents(events: AsyncIterable<CanonicalResponseEvent>): Promise<void> {
  for await (const _event of events) {
    // Consume the complete stream to exercise its transport bounds.
  }
}

function parseSse(body: string): Array<{ event: string; data: Record<string, unknown> }> {
  return body
    .trim()
    .split(/\r?\n\r?\n/)
    .map((frameText) => {
      const lines = frameText.split(/\r?\n/);
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
      if (event === undefined || data === undefined) {
        throw new Error(`Invalid SSE frame: ${frameText}`);
      }
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}
