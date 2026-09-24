import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AnthropicMessagesGateway,
  CHATGPT_CODEX_RESPONSES_URL,
  CodexResponsesAdapter,
  encodeAnthropicSse,
  encodeReasoningSignature,
  setWireLogTarget,
} from "../../../../src/index.js";
import type { CanonicalResponseEvent, CanonicalResponseRequest } from "../../../../src/index.js";

function request(overrides: Partial<CanonicalResponseRequest> = {}): CanonicalResponseRequest {
  return {
    model: "gpt-6-luna",
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

  it("replays only its own reasoning blobs, as an item before the call they preceded", async () => {
    // A conversation that reasoned on Grok carries its blobs in thinking signatures. Continued on
    // a Codex model without the client knowing (e.g. an operator model override), each blob lands
    // on the item it preceded; the backend refuses any unknown item field with a 400 that fails
    // the whole request, and a foreign blob is one it cannot read. Its own blob it takes back.
    const grok = encodeReasoningSignature("rs_grok", "grok-opaque-blob", "xai");
    const codex = encodeReasoningSignature("rs_codex", "gAAAAAB-codex-blob", "codex");
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    await new AnthropicMessagesGateway(new CodexResponsesAdapter({ fetch: fetchMock })).stream({
      model: "claude-gateway--xai--grok-4.7",
      max_tokens: 64,
      stream: true,
      messages: [
        { role: "user", content: "Read a.txt." },
        { role: "assistant", content: [
          { type: "thinking", thinking: "Read it first.", signature: grok },
          { type: "tool_use", id: "call_a", name: "Read", input: { file_path: "a.txt" } },
        ] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_a", content: "17" }] },
        { role: "assistant", content: [
          { type: "thinking", thinking: "Now b.", signature: codex },
          { type: "tool_use", id: "call_b", name: "Read", input: { file_path: "b.txt" } },
        ] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_b", content: "33" }] },
      ],
    } as never, { apiKey: "k", model: "gpt-6-sol" });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { input: Array<Record<string, unknown>> };
    const reasoning = body.input.filter((item) => item.type === "reasoning");
    expect(reasoning).toEqual([{ type: "reasoning", summary: [], encrypted_content: "gAAAAAB-codex-blob" }]);
    expect(body.input[body.input.indexOf(reasoning[0]!) + 1]).toMatchObject({ type: "function_call", call_id: "call_b" });
    expect(body.input.find((item) => item.type === "function_call"))
      .toMatchObject({ call_id: "call_a", name: "Read" });
    for (const item of body.input) {
      expect(item).not.toHaveProperty("reasoning_encrypted");
      expect(item).not.toHaveProperty("reasoning_id");
      expect(item).not.toHaveProperty("reasoning_content");
      expect(item).not.toHaveProperty("reasoning_origin");
    }
  });

  it("resends a turn without its reasoning replay when the backend refuses the blob", async () => {
    // A damaged blob, or one issued for another account, is refused before any stream opens. It
    // sits in the client's history, so without this every later turn would fail the same way.
    const wireLogPath = wireLogFile();
    const refused = new Response(JSON.stringify({ error: {
      message: "The encrypted content gAAA...1Ea8 could not be verified.",
      type: "invalid_request_error",
      param: null,
      code: "invalid_encrypted_content",
    } }), { status: 400, headers: { "content-type": "application/json" } });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(refused)
      .mockResolvedValueOnce(sse(
        `data: ${JSON.stringify({ type: "response.created", response: { id: "r", model: "gpt-6-sol" } })}\n\n`,
        `data: ${JSON.stringify({ type: "response.completed", response: { id: "r", model: "gpt-6-sol", usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
      ));
    const events: CanonicalResponseEvent[] = [];
    const response = await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request({
      input: [
        { type: "message", role: "user", content: "Read a.txt." },
        { type: "function_call", call_id: "call_a", name: "Read", arguments: "{}", reasoning_encrypted: "gAAAAAB-damaged", reasoning_origin: "codex" },
        { type: "function_call_output", call_id: "call_a", output: "17" },
      ],
    }), { apiKey: "k" });
    if (!response.ok) throw new Error(`expected recovery, got ${response.status}`);
    for await (const event of response.events) events.push(event);

    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as { input: Array<{ type?: string }> });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.input.some((item) => item.type === "reasoning")).toBe(true);
    expect(bodies[1]?.input.some((item) => item.type === "reasoning")).toBe(false);
    expect(events.at(-1)?.type).toBe("response.completed");
    expect(readWireLogLines(wireLogPath).some((entry) => entry.event === "codex.replay.dropped")).toBe(true);
  });

  it("drops only the tool patterns the backend's regex engine rejects", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    await new CodexResponsesAdapter({ fetch: fetchMock }).stream(request({
      tools: [{
        type: "function",
        name: "Artifact",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            // Lookaround and Unicode property escapes: RE2 reads neither, and the backend
            // refuses the whole request rather than the one tool.
            field: { type: "string", pattern: "^(?!__.*__$)[^\\p{Cc}\\p{Cf}]{1,200}$" },
            asset_id: { type: "string", pattern: "^[0-9a-f]{32}$" },
            writes: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: { doc_id: { type: "string", pattern: "^(?!\\.\\.?$)[A-Za-z0-9_-]{1,200}$" } },
                required: ["doc_id"],
              },
            },
          },
          required: ["field", "asset_id", "writes"],
        },
      }],
      tool_choice: "auto",
    }), { apiKey: "k" });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      tools: Array<{ parameters: { properties: Record<string, Record<string, unknown>> } }>;
    };
    const properties = body.tools[0]!.parameters.properties;
    expect(properties.field).not.toHaveProperty("pattern");
    expect(properties.asset_id).toHaveProperty("pattern", "^[0-9a-f]{32}$");
    expect(
      (properties.writes!.items as { properties: Record<string, Record<string, unknown>> }).properties.doc_id,
    ).not.toHaveProperty("pattern");
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
});
