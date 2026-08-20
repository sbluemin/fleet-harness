import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AnthropicMessagesGateway,
  CHATGPT_CODEX_RESPONSES_URL,
  CodexResponsesAdapter,
  encodeAnthropicSse,
  setWireLogTarget,
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

const temporaryWireLogDirectories: string[] = [];

afterEach(() => {
  setWireLogTarget(undefined);
  for (const directory of temporaryWireLogDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function wireLogFile(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "fleet-codex-wire-log-"));
  temporaryWireLogDirectories.push(directory);
  const filePath = path.join(directory, "wire-log.jsonl");
  setWireLogTarget({ path: filePath });
  return filePath;
}

function readWireLogLines(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function discardedRetryEntries(filePath: string): Array<Record<string, unknown>> {
  return readWireLogLines(filePath).filter((entry) => entry.event === "codex.retry.discarded");
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

  it("pins the prefix cache with a session_id header and prompt_cache_key derived from metadata.user_id", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request({
      metadata: { user_id: "user_abc_account_1_session_2" },
    }), { apiKey: "k" });

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    const sessionId = headers.get("session_id");
    // Sticky routing on this backend keys on the header, so both spellings must be the
    // same value; the caller's own metadata still never reaches the wire body.
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(body.prompt_cache_key).toBe(sessionId);
    expect(body).not.toHaveProperty("metadata");
  });

  it("derives the same identity for the same user_id and a different one otherwise", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    const adapter = new CodexResponsesAdapter({ fetch: fetchMock });
    await adapter.stream(request({ metadata: { user_id: "session-a" } }), { apiKey: "k" });
    // A gateway builds one adapter per request, so the value must come from the caller,
    // not from adapter lifetime.
    await new CodexResponsesAdapter({ fetch: fetchMock })
      .stream(request({ metadata: { user_id: "session-a" } }), { apiKey: "k" });
    await adapter.stream(request({ metadata: { user_id: "session-b" } }), { apiKey: "k" });

    const sessionIds = fetchMock.mock.calls.map(
      (call) => new Headers(call[1]?.headers).get("session_id"),
    );
    expect(sessionIds[0]).toBe(sessionIds[1]);
    expect(sessionIds[2]).not.toBe(sessionIds[0]);
  });

  it("omits both spellings when the caller sent no user_id", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request({
      metadata: { session: "s" },
    }), { apiKey: "k" });

    // A per-turn identity would pin every turn to a different machine, which is strictly
    // worse than sending none.
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("session_id")).toBeNull();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)))
      .not.toHaveProperty("prompt_cache_key");
  });

  it("omits all tool controls for explicit tool_choice none", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request({
      tools: [{
        type: "function",
        name: "Bash",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      }],
      tool_choice: "none",
      parallel_tool_calls: true,
      native_tools: [{ type: "web_search" }],
    }), { apiKey: "k" });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("native_tools");
    expect(body).not.toHaveProperty("parallel_tool_calls");
  });

  it("keeps ordinary auto tool controls on the Codex backend", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request({
      tools: [{
        type: "function",
        name: "Bash",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      }],
      tool_choice: "auto",
      parallel_tool_calls: true,
    }), { apiKey: "k" });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toBe("auto");
    expect(body.parallel_tool_calls).toBe(true);
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

  it("retries a server_error after a message output_item.added setup event", async () => {
    const failed = 'data: {"type":"response.failed","response":{"id":"r1","model":"gpt-5.6-luna","error":{"code":"server_error","message":"An error occurred while processing your request. Please include request ID req-1."}}}\n\n';
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sse(
        'data: {"type":"response.created","response":{"id":"r1","model":"gpt-5.6-luna"}}\n\n',
        'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg-1","role":"assistant"}}\n\n',
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
    // output_item.added(message)는 caller-visible 출력이 아니므로 retry를 막지 않는다.
    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_text.delta",
      "response.completed",
    ]);
    expect(events[0]).toMatchObject({ response: { id: "r2" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a message setup event inside the retry lead so the Anthropic caller sees only r2", async () => {
    const failed = 'data: {"type":"response.failed","response":{"id":"r1","model":"gpt-5.6-luna","error":{"code":"server_error","message":"An error occurred while processing your request. Please include request ID req-1."}}}\n\n';
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sse(
        'data: {"type":"response.created","response":{"id":"r1","model":"gpt-5.6-luna"}}\n\n',
        'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg-1","role":"assistant"}}\n\n',
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
    // r1의 created/add(message)는 버퍼에서 폐기된다. message_start는 r2를 싣고
    // r2의 내용과 usage가 atomic하게 내려온다.
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

  it("cancels a pending initial read when the consumer closes the iterator", async () => {
    const encoder = new TextEncoder();
    const hanging = new ReadableStream<Uint8Array>({
      start(controller) {
        // 첫 프레임은 created(버퍼 lead)만 내보내고 그 뒤로는 hang한다.
        controller.enqueue(
          encoder.encode('data: {"type":"response.created","response":{"id":"r1","model":"gpt-5.6-luna"}}\n\n')
        );
      },
    });
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(hanging, { status: 200 }));

    const response = await new CodexResponsesAdapter({
      fetch: fetchMock,
      idleTimeoutMs: 300,
    }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected success");

    const iterator = response.events[Symbol.asyncIterator]();
    // created가 버퍼되고 source.next()가 초기 스트림에서 hang한 채로 return을 호출한다.
    const pendingNext = iterator.next().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const startedAt = Date.now();
    await iterator.return?.();
    const elapsed = Date.now() - startedAt;

    // return은 per-call 컨트롤러 abort로 초기 read를 즉시 취소하므로 idle timeout(300ms)을
    // 기다리지 않는다.
    expect(elapsed).toBeLessThan(150);
    await pendingNext;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("logs discarded response.failed retry evidence without duplicating passed events", async () => {
    const filePath = wireLogFile();
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
    for await (const _event of response.events) {
      // drain
    }

    // 폐기되는 r1 실패 증거는 게이트웨이 wrapper에 도달하기 전 버려지므로 이 seam에서 남긴다.
    const discarded = discardedRetryEntries(filePath);
    expect(discarded).toHaveLength(1);
    expect(discarded[0]).toMatchObject({
      event: "codex.retry.discarded",
      payload: {
        reason: "response.failed",
        event: {
          type: "response.failed",
          response: {
            id: "r1",
            error: { type: "server_error", message: expect.stringContaining("req-1") },
          },
        },
      },
    });
    // 성공 응답의 일반 이벤트(r2 delta)는 이 discard 항목에 중복 기록되지 않는다.
    const serialized = JSON.stringify(discarded);
    expect(serialized).not.toContain("output_text.delta");
    expect(serialized).not.toContain('"id":"r2"');
  });

  it("logs both discarded events for an error + response.failed retry pair", async () => {
    const filePath = wireLogFile();
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
    for await (const _event of response.events) {
      // drain
    }

    const discarded = discardedRetryEntries(filePath);
    expect(discarded).toHaveLength(1);
    expect(discarded[0]).toMatchObject({
      event: "codex.retry.discarded",
      payload: { reason: "error_failed_pair" },
    });
    const pairEvents = (discarded[0]?.payload as { events?: unknown[] } | undefined)?.events;
    expect(pairEvents).toMatchObject([
      { type: "error", error: { type: "service_unavailable_error", message: "temporarily unavailable" } },
      {
        type: "response.failed",
        response: { id: "r1", error: { type: "server_is_overloaded", message: "overloaded" } },
      },
    ]);
  });

  it("logs a payload-light diagnostic for a socket termination retry", async () => {
    const filePath = wireLogFile();
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
    for await (const _event of response.events) {
      // drain
    }

    // 소켓 termination은 canonical 이벤트가 없으므로 type+phase만 남긴다.
    const discarded = discardedRetryEntries(filePath);
    expect(discarded).toHaveLength(1);
    expect(discarded[0]).toMatchObject({
      event: "codex.retry.discarded",
      payload: { reason: "socket_termination", phase: "pre_commit" },
    });
  });

  it("records the raw provider event before canonical type normalization", async () => {
    const filePath = wireLogFile();
    const fetchMock = vi.fn<typeof fetch>(async () => sse(
      'event: response.reasoning_text.delta\ndata: {"item_id":"reasoning-raw","output_index":0,"delta":"checking"}\n\n',
    ));

    const response = await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected success");
    const events: CanonicalResponseEvent[] = [];
    for await (const event of response.events) events.push(event);

    expect(events).toEqual([{
      type: "response.reasoning_summary_text.delta",
      item_id: "reasoning-raw",
      output_index: 0,
      delta: "checking",
    }]);
    const raw = readWireLogLines(filePath).filter((entry) => entry.event === "openai.wire.event");
    expect(raw).toEqual([expect.objectContaining({
      payload: {
        event: "response.reasoning_text.delta",
        data: { item_id: "reasoning-raw", output_index: 0, delta: "checking" },
      },
    })]);
    expect(JSON.stringify(raw)).not.toContain("sk-codex");
  });

  it("preserves discarded failure evidence before the gateway canonical-event wrapper", async () => {
    const filePath = wireLogFile();
    const failed = 'data: {"type":"response.failed","response":{"id":"r1","model":"gpt-5.6-luna","error":{"code":"server_error","message":"An error occurred while processing your request. Please include request ID req-1."}}}\n\n';
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        'data: {"type":"response.created","response":{"id":"r1","model":"gpt-5.6-luna"}}\n\n'
        + 'data: {"type":"response.reasoning_text.delta","item_id":"reasoning-1","output_index":0,"delta":"checking"}\n\n'
        + failed,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ))
      .mockResolvedValueOnce(new Response(
        'data: {"type":"response.created","response":{"id":"r2","model":"gpt-5.6-luna"}}\n\n'
        + 'data: {"type":"response.output_text.delta","item_id":"message-1","output_index":0,"content_index":0,"delta":"OK"}\n\n'
        + 'data: {"type":"response.completed","response":{"id":"r2","model":"gpt-5.6-luna","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ));

    const gateway = new AnthropicMessagesGateway(new CodexResponsesAdapter({ fetch: fetchMock }));
    const stream = await gateway.stream(
      { model: "gpt-5.6-luna", messages: [{ role: "user", content: "hi" }], max_tokens: 1024, stream: true },
      { apiKey: "k" },
    );
    await collectBody(stream.body);

    const entries = readWireLogLines(filePath);
    // 폐기된 r1 실패 증거는 게이트웨이 wrapper에 도달하기 전 seam에서 남는다.
    const discarded = entries.filter((entry) => entry.event === "codex.retry.discarded");
    expect(discarded).toHaveLength(1);
    expect(discarded[0]?.payload).toMatchObject({
      reason: "response.failed",
      event: {
        type: "response.failed",
        response: { id: "r1", error: { type: "server_error", message: expect.stringContaining("req-1") } },
      },
    });
    // 통과한 r2 이벤트는 wrapper가 정확히 한 번씩 기록하고, r1 폐기분은 wrapper에 닿지 않는다.
    const canonicalEvents = entries.filter((entry) => entry.event === "canonical.event");
    expect(canonicalEvents).toHaveLength(3);
    expect(canonicalEvents.map((entry) => (entry.payload as { type?: unknown }).type)).toEqual([
      "response.created",
      "response.output_text.delta",
      "response.completed",
    ]);
    expect(JSON.stringify(canonicalEvents)).not.toContain('"id":"r1"');
  });

  it("spends the retry budget on a fetch-level socket retry and passes failures through", async () => {
    const filePath = wireLogFile();
    const socketError = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    const failed = 'data: {"type":"response.failed","response":{"id":"r1","model":"gpt-5.6-luna","error":{"code":"server_error","message":"req-1"}}}\n\n';
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("terminated", { cause: socketError }))
      .mockResolvedValueOnce(sse(
        'data: {"type":"response.created","response":{"id":"r1","model":"gpt-5.6-luna"}}\n\n',
        'data: {"type":"response.reasoning_text.delta","item_id":"reasoning-1","output_index":0,"delta":"checking"}\n\n',
        failed,
      ));

    const response = await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected success");
    const events = [];
    for await (const event of response.events) events.push(event);

    // fetch-level retry가 예산을 소모했으므로 server_error는 retry되지 않고 원래 순서대로
    // terminal로 노출된다. created/reasoning lead도 보존된다.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.reasoning_summary_text.delta",
      "response.failed",
    ]);
    expect(events.at(-1)).toMatchObject({
      response: { id: "r1", error: { type: "server_error", message: "req-1" } },
    });

    // fetch-level retry는 payload-light 진단으로 기록되고, stream-level discard는 없다.
    const discarded = discardedRetryEntries(filePath);
    expect(discarded).toHaveLength(1);
    expect(discarded[0]).toMatchObject({
      event: "codex.retry.discarded",
      payload: { reason: "socket_termination", phase: "fetch" },
    });
  });

  it("does not retry a third time when a fetch-retried stream socket terminates", async () => {
    const socketError = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const terminated = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(
          encoder.encode('data: {"type":"response.created","response":{"id":"r1","model":"gpt-5.6-luna"}}\n\n')
        );
      },
    });
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("terminated", { cause: socketError }))
      .mockResolvedValueOnce(new Response(terminated, { status: 200 }));

    const response = await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected success");
    const iterator = response.events[Symbol.asyncIterator]();
    const eventTypes: string[] = [];
    let caught: unknown;
    const drain = (async () => {
      try {
        for (;;) {
          const { done, value } = await iterator.next();
          if (done) break;
          eventTypes.push(value.type);
        }
      } catch (error) {
        caught = error;
      }
    })();
    // 첫 read가 created를 소비하고 두 번째 read가 대기한 뒤 소켓을 종료시킨다.
    await new Promise((resolve) => setTimeout(resolve, 20));
    streamController?.error(new TypeError("terminated", { cause: socketError }));
    await drain;

    // 예산이 소모된 상태의 소켓 termination은 보류 lead를 원래 순서로 내보낸 뒤 에러를
    // 전파한다. 세 번째 호출은 없다.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(eventTypes).toEqual(["response.created"]);
    expect(caught).toMatchObject({ message: "terminated" });
  });

  it("passes a generic retryable error through when the budget is spent", async () => {
    const socketError = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("terminated", { cause: socketError }))
      .mockResolvedValueOnce(sse(
        'data: {"type":"response.created","response":{"id":"r1","model":"gpt-5.6-luna"}}\n\n',
        'data: {"type":"error","error":{"code":"service_unavailable_error","message":"temporarily unavailable"}}\n\n',
      ));

    const response = await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected success");
    const events = [];
    for await (const event of response.events) events.push(event);

    // 예산이 소모된 상태의 generic retryable error는 pending 없이 원래 순서로 terminal로
    // 통과하고, 세 번째 호출은 없다.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.type)).toEqual(["response.created", "error"]);
    expect(events.at(-1)).toMatchObject({
      error: { type: "service_unavailable_error", message: "temporarily unavailable" },
    });
  });

  it("keeps the stream-level retry at two calls when the retried response also fails", async () => {
    const failed = 'data: {"type":"response.failed","response":{"id":"r1","model":"gpt-5.6-luna","error":{"code":"server_error","message":"req-1"}}}\n\n';
    const failedAgain = 'data: {"type":"response.failed","response":{"id":"r2","model":"gpt-5.6-luna","error":{"code":"server_error","message":"req-2"}}}\n\n';
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sse(
        'data: {"type":"response.created","response":{"id":"r1","model":"gpt-5.6-luna"}}\n\n',
        failed,
      ))
      .mockResolvedValueOnce(sse(
        'data: {"type":"response.created","response":{"id":"r2","model":"gpt-5.6-luna"}}\n\n',
        failedAgain,
      ));

    const response = await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected success");
    const events = [];
    for await (const event of response.events) events.push(event);

    // stream-level retry(2번째 호출)의 응답도 server_error면 그대로 terminal로 노출되며
    // 세 번째 호출은 없다.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.type)).toEqual(["response.created", "response.failed"]);
    expect(events[0]).toMatchObject({ response: { id: "r2" } });
    expect(events.at(-1)).toMatchObject({ response: { id: "r2", error: { type: "server_error" } } });
  });
});
