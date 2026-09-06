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
} from "../../../../src/index.js";
import type { CanonicalResponseEvent, CanonicalResponseRequest } from "../../../../src/index.js";

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
