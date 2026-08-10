import { describe, expect, it, vi } from "vitest";

import {
  CHATGPT_CODEX_RESPONSES_URL,
  CodexResponsesAdapter,
} from "../../../src/index.js";
import type { CanonicalResponseRequest } from "../../../src/index.js";

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

  it("does not retry UND_ERR_SOCKET after a canonical event was yielded", async () => {
    const encoder = new TextEncoder();
    const socketError = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const terminated = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(encoder.encode('data: {"type":"response.created","response":{"id":"r","model":"gpt-5.6-luna"}}\n\n'));
      },
    });
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(terminated, { status: 200 }));

    const response = await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected success");
    const iterator = response.events[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "response.created" } });
    streamController?.error(new TypeError("terminated", { cause: socketError }));
    await expect(iterator.next()).rejects.toMatchObject({ message: "terminated" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
