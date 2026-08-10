import { describe, expect, it, vi } from "vitest";

import {
  CHATGPT_CODEX_RESPONSES_URL,
  CodexResponsesAdapter,
  encodeAnthropicSse,
} from "../../../src/index.js";
import type { CanonicalResponseEvent, CanonicalResponseRequest } from "../../../src/index.js";

function request(overrides: Partial<CanonicalResponseRequest> = {}): CanonicalResponseRequest {
  return {
    model: "gpt-5.6-luna",
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

async function collectBody(body: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of body) {
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
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

describe("codex responses adapter", () => {
  it("always targets CHATGPT_CODEX_RESPONSES_URL and sends Bearer auth", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "sk-codex" });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(CHATGPT_CODEX_RESPONSES_URL);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-codex");
  });

  it("sends the account id and extra headers", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    await new CodexResponsesAdapter({
      fetch: fetchMock,
      accountId: "acct-1",
      headers: { originator: "fleet-console" },
    }).stream(request(), { apiKey: "k" });
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("chatgpt-account-id")).toBe("acct-1");
    expect(headers.get("originator")).toBe("fleet-console");
  });

  it("drops ChatGPT-unsupported sampling fields and forces store:false", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request({
      max_output_tokens: 256,
      metadata: { session: "s" },
    }), { apiKey: "k" });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body).not.toHaveProperty("metadata");
    expect(body.store).toBe(false);
  });

  it("omits tools from Claude Code suggestion-mode requests", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request({
      input: [{
        type: "message",
        role: "user",
        content: "[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]\n\nReply with ONLY the suggestion.",
      }],
      tools: [{
        type: "function",
        name: "Bash",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      }],
      tool_choice: "auto",
      parallel_tool_calls: true,
      native_tools: [{ type: "web_search" }],
    }), { apiKey: "k" });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("parallel_tool_calls");
    expect(body).not.toHaveProperty("include");
  });

  it("keeps tools when suggestion-mode text is not the last input", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request({
      input: [
        {
          type: "message",
          role: "user",
          content: "[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]",
        },
        { type: "message", role: "user", content: "Run the tool." },
      ],
      tools: [{
        type: "function",
        name: "Bash",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      }],
    }), { apiKey: "k" });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.tools).toHaveLength(1);
  });

  it("retries one UND_ERR_SOCKET before the response starts", async () => {
    const socketError = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("terminated", { cause: socketError }))
      .mockResolvedValueOnce(sse("data: [DONE]\n\n"));

    const response = await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries one UND_ERR_SOCKET before the first canonical event", async () => {
    const socketError = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    const terminated = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError("terminated", { cause: socketError }));
      },
    });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(terminated, { status: 200 }))
      .mockResolvedValueOnce(sse("data: [DONE]\n\n"));

    const response = await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected success");
    const events = [];
    for await (const event of response.events) events.push(event);
    expect(events).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry UND_ERR_SOCKET after caller-visible output was yielded", async () => {
    const encoder = new TextEncoder();
    const socketError = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const terminated = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","item_id":"m","output_index":0,"content_index":0,"delta":"partial"}\n\n'));
      },
    });
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(terminated, { status: 200 }));

    const response = await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected success");
    const iterator = response.events[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "response.output_text.delta" } });
    streamController?.error(new TypeError("terminated", { cause: socketError }));
    await expect(iterator.next()).rejects.toMatchObject({ message: "terminated" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries UND_ERR_SOCKET while created/reasoning are still buffered", async () => {
    const encoder = new TextEncoder();
    const socketError = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    const terminated = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"response.created","response":{"id":"r1","model":"gpt-5.6-luna"}}\n\n'));
        controller.error(new TypeError("terminated", { cause: socketError }));
      },
    });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(terminated, { status: 200 }))
      .mockResolvedValueOnce(sse(
        'data: {"type":"response.created","response":{"id":"r2","model":"gpt-5.6-luna"}}\n\n',
        'data: {"type":"response.output_text.delta","item_id":"m","output_index":0,"content_index":0,"delta":"OK"}\n\n',
        'data: {"type":"response.completed","response":{"id":"r2","model":"gpt-5.6-luna","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      ));

    const response = await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected success");
    const events = [];
    for await (const event of response.events) events.push(event);
    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_text.delta",
      "response.completed",
    ]);
    expect(events[0]).toMatchObject({ response: { id: "r2" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries one server_error after reasoning but before output and discards the failed attempt's lead", async () => {
    const failed = 'data: {"type":"response.failed","response":{"id":"r1","model":"gpt-5.6-luna","error":{"code":"server_error","message":"An error occurred while processing your request. Please include request ID req-1."}}}\n\n';
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sse(
        'data: {"type":"response.created","response":{"id":"r1","model":"gpt-5.6-luna"}}\n\n',
        'data: {"type":"response.reasoning_text.delta","item_id":"reasoning-1","output_index":0,"delta":"checking"}\n\n',
        failed,
      ))
      .mockResolvedValueOnce(sse(
        'data: {"type":"response.created","response":{"id":"r2","model":"gpt-5.6-luna"}}\n\n',
        'data: {"type":"response.output_text.delta","item_id":"message-1","output_index":0,"content_index":0,"delta":"OK"}\n\n',
        'data: {"type":"response.completed","response":{"id":"r2","model":"gpt-5.6-luna","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      ));

    const response = await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected success");
    const events = [];
    for await (const event of response.events) events.push(event);
    // 첫 attempt의 created/reasoning은 retry 시 폐기되고 두 번째 attempt만 노출된다.
    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_text.delta",
      "response.completed",
    ]);
    expect(events[0]).toMatchObject({ response: { id: "r2" } });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "response.failed" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("exposes only the retried attempt to the Anthropic SSE caller", async () => {
    const failed = 'data: {"type":"response.failed","response":{"id":"r1","model":"gpt-5.6-luna","error":{"code":"server_error","message":"An error occurred while processing your request. Please include request ID req-1."}}}\n\n';
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sse(
        'data: {"type":"response.created","response":{"id":"r1","model":"gpt-5.6-luna"}}\n\n',
        'data: {"type":"response.reasoning_text.delta","item_id":"reasoning-1","output_index":0,"delta":"checking"}\n\n',
        failed,
      ))
      .mockResolvedValueOnce(sse(
        'data: {"type":"response.created","response":{"id":"r2","model":"gpt-5.6-luna"}}\n\n',
        'data: {"type":"response.output_text.delta","item_id":"message-1","output_index":0,"content_index":0,"delta":"OK"}\n\n',
        'data: {"type":"response.completed","response":{"id":"r2","model":"gpt-5.6-luna","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      ));

    const response = await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected success");
    const frames = parseSse(await collectBody(encodeAnthropicSse(response.events)));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // r1의 created/reasoning은 retry 시 폐기된다. message_start r1/thinking이 아니라
    // r2 헤더 아래 r2의 내용과 usage가 atomic하게 실려야 한다.
    expect(frames.map((frame) => frame.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(frames[0]?.data).toMatchObject({
      type: "message_start",
      message: { id: "r2", model: "gpt-5.6-luna" },
    });
    expect(frames[1]?.data).toMatchObject({ content_block: { type: "text", text: "" } });
    expect(frames[2]?.data).toMatchObject({ delta: { type: "text_delta", text: "OK" } });
    expect(frames[4]?.data).toMatchObject({
      type: "message_delta",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });

  it("retries the observed overload error pair before output", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sse(
        'data: {"type":"response.created","response":{"id":"r1","model":"gpt-5.6-luna"}}\n\n',
        'data: {"type":"error","error":{"code":"service_unavailable_error","message":"temporarily unavailable"}}\n\n',
        'data: {"type":"response.failed","response":{"id":"r1","model":"gpt-5.6-luna","error":{"code":"server_is_overloaded","message":"overloaded"}}}\n\n',
      ))
      .mockResolvedValueOnce(sse(
        'data: {"type":"response.created","response":{"id":"r2","model":"gpt-5.6-luna"}}\n\n',
        'data: {"type":"response.completed","response":{"id":"r2","model":"gpt-5.6-luna","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      ));

    const response = await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected success");
    const events = [];
    for await (const event of response.events) events.push(event);
    // r1의 created는 retry 시 폐기되고 r2만 노출된다.
    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.completed",
    ]);
    expect(events[0]).toMatchObject({ response: { id: "r2" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves a standalone retryable provider error when no failed event follows", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse(
      'data: {"type":"error","error":{"code":"service_unavailable_error","message":"temporarily unavailable"}}\n\n',
    ));

    const response = await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected success");
    const events = [];
    for await (const event of response.events) events.push(event);
    expect(events).toEqual([{
      type: "error",
      error: { type: "service_unavailable_error", message: "temporarily unavailable" },
    }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves created and reasoning in order when the first attempt succeeds", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse(
      'data: {"type":"response.created","response":{"id":"r1","model":"gpt-5.6-luna"}}\n\n',
      'data: {"type":"response.reasoning_text.delta","item_id":"reasoning-1","output_index":0,"delta":"checking"}\n\n',
      'data: {"type":"response.output_text.delta","item_id":"message-1","output_index":0,"content_index":0,"delta":"OK"}\n\n',
      'data: {"type":"response.completed","response":{"id":"r1","model":"gpt-5.6-luna","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
    ));

    const response = await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected success");
    const events = [];
    for await (const event of response.events) events.push(event);
    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.reasoning_summary_text.delta",
      "response.output_text.delta",
      "response.completed",
    ]);
    expect(events[0]).toMatchObject({ response: { id: "r1" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves created and reasoning before a non-retryable terminal failure", async () => {
    const failed = 'data: {"type":"response.failed","response":{"id":"r1","model":"gpt-5.6-luna","error":{"code":"invalid_prompt","message":"bad prompt"}}}\n\n';
    const fetchMock = vi.fn<typeof fetch>(async () => sse(
      'data: {"type":"response.created","response":{"id":"r1","model":"gpt-5.6-luna"}}\n\n',
      'data: {"type":"response.reasoning_text.delta","item_id":"reasoning-1","output_index":0,"delta":"checking"}\n\n',
      failed,
    ));

    const response = await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected success");
    const events = [];
    for await (const event of response.events) events.push(event);
    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.reasoning_summary_text.delta",
      "response.failed",
    ]);
    expect(events.at(-1)).toMatchObject({ response: { error: { type: "invalid_prompt" } } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry again when the server_error retry fails", async () => {
    const failed = 'data: {"type":"response.failed","response":{"id":"r1","model":"gpt-5.6-luna","error":{"code":"server_error","message":"internal"}}}\n\n';
    const socketError = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sse(failed))
      .mockRejectedValueOnce(new TypeError("terminated", { cause: socketError }));

    const response = await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected success");
    await expect((async () => {
      for await (const _event of response.events) {
        // drain
      }
    })()).rejects.toMatchObject({ message: "terminated" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cancels a pending retry when the consumer closes the iterator", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse(
      'data: {"type":"response.created","response":{"id":"r1","model":"gpt-5.6-luna"}}\n\n',
      'data: {"type":"response.failed","response":{"id":"r1","model":"gpt-5.6-luna","error":{"code":"server_error","message":"internal"}}}\n\n',
    ));

    const response = await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected success");
    const iterator = response.events[Symbol.asyncIterator]();
    // 첫 next()가 created를 버퍼링하고 실패를 만나 retry 지연에 진입한다.
    const pendingNext = iterator.next().catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const closeResult = await Promise.race([
      iterator.return?.().then(() => "closed" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 150)),
    ]);
    expect(closeResult).toBe("closed");
    await pendingNext;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight retry fetch when the consumer closes the iterator", async () => {
    let retryStarted: (() => void) | undefined;
    const retryStart = new Promise<void>((resolve) => {
      retryStarted = resolve;
    });
    let retryAborted = false;
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sse(
        'data: {"type":"response.created","response":{"id":"r1","model":"gpt-5.6-luna"}}\n\n',
        'data: {"type":"response.failed","response":{"id":"r1","model":"gpt-5.6-luna","error":{"code":"server_error","message":"internal"}}}\n\n',
      ))
      .mockImplementationOnce(async (_input, init) => {
        retryStarted?.();
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            retryAborted = true;
            reject(init.signal?.reason);
          }, { once: true });
        });
      });

    const response = await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected success");
    const iterator = response.events[Symbol.asyncIterator]();
    // 첫 next()가 created를 버퍼링하고 실패를 만나 retry fetch를 시작한다.
    const pendingNext = iterator.next().catch((error: unknown) => error);
    await retryStart;
    await iterator.return?.();
    await pendingNext;
    expect(retryAborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry terminal provider errors or server_error after output", async () => {
    const cases = [
      { error: { code: "invalid_prompt", message: "bad prompt" }, prefix: [] },
      { error: { code: "rate_limit_exceeded", message: "try later" }, prefix: [] },
      {
        error: { code: "server_error", message: "second terminal error" },
        prefix: ['data: {"type":"error","error":{"code":"api_error","message":"first terminal error"}}\n\n'],
      },
      {
        error: { code: "server_error", message: "internal" },
        prefix: ['data: {"type":"response.output_text.delta","item_id":"m","output_index":0,"content_index":0,"delta":"partial"}\n\n'],
      },
      {
        error: { code: "server_error", message: "internal" },
        prefix: ['data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"f","call_id":"c","name":"Bash","arguments":"{}"}}\n\n'],
      },
    ];

    for (const testCase of cases) {
      const failed = `data: ${JSON.stringify({
        type: "response.failed",
        response: { id: "r", model: "gpt-5.6-luna", error: testCase.error },
      })}\n\n`;
      const fetchMock = vi.fn<typeof fetch>(async () => sse(...testCase.prefix, failed));
      const response = await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
      if (!response.ok) throw new Error("expected success");
      const events = [];
      for await (const event of response.events) events.push(event);
      expect(events.at(-1)).toMatchObject({ type: "response.failed" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("does not retry a known HTTP status when its error body socket terminates", async () => {
    const socketError = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    const terminated = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError("terminated", { cause: socketError }));
      },
    });
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(terminated, { status: 429 }));

    await expect(new CodexResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" }))
      .rejects.toMatchObject({ message: "terminated" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry caller aborts or unrelated transport failures", async () => {
    const caller = new AbortController();
    caller.abort(new Error("caller stopped"));
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    });
    await expect(new CodexResponsesAdapter({ fetch: fetchMock }).stream(request(), {
      apiKey: "k",
      signal: caller.signal,
    })).rejects.toThrow("other side closed");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const unrelated = vi.fn<typeof fetch>(async () => {
      throw Object.assign(new Error("connect reset"), { code: "ECONNRESET" });
    });
    await expect(new CodexResponsesAdapter({ fetch: unrelated }).stream(request(), { apiKey: "k" }))
      .rejects.toThrow("connect reset");
    expect(unrelated).toHaveBeenCalledTimes(1);
  });

  it("validates explicit zero limits instead of silently accepting them", () => {
    expect(() => new CodexResponsesAdapter({ maxBodyBytes: 0 })).toThrow(TypeError);
    expect(() => new CodexResponsesAdapter({ idleTimeoutMs: 0 })).toThrow(TypeError);
  });
});
