import { describe, expect, it, vi } from "vitest";

import {
  OPENCODE_GO_RESPONSES_URL,
  OpencodeGoResponsesAdapter,
  createOpencodeGoAdapter,
} from "../../../../src/index.js";
import type { CanonicalResponseEvent, CanonicalResponseRequest } from "../../../../src/index.js";
import { wireLogFixture } from "../../../helpers/wire-log.js";

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

function chunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function collect(events: AsyncIterable<CanonicalResponseEvent>): Promise<CanonicalResponseEvent[]> {
  const out: CanonicalResponseEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("opencode go responses adapter", () => {
  it("is the adapter createOpencodeGoAdapter('responses') builds", () => {
    expect(createOpencodeGoAdapter("responses")).toBeInstanceOf(OpencodeGoResponsesAdapter);
  });

  it("sends requests to OPENCODE_GO_RESPONSES_URL with Bearer auth by default", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    await new OpencodeGoResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "sk-go" });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(OPENCODE_GO_RESPONSES_URL);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-go");
  });

  it("keeps sampling fields the ChatGPT backend would reject instead of dropping them", async () => {
    // Codex's subscription adapter force-drops these; the OpenCode Go Responses
    // adapter shares the OpenAI wire but owns its own semantics, so they must pass through.
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    await new OpencodeGoResponsesAdapter({ fetch: fetchMock }).stream(request({
      max_output_tokens: 128,
      metadata: { session: "s" },
    }), { apiKey: "k" });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.max_output_tokens).toBe(128);
    expect(body.metadata).toEqual({ session: "s" });
    // No ChatGPT store:false coercion either.
    expect(body).not.toHaveProperty("store");
  });

  it("records raw response events that canonical translation drops", async () => {
    const wireLog = wireLogFixture("fleet-opencode-responses-wire-log-");
    try {
      const rawDelta = {
        type: "response.function_call_arguments.delta",
        item_id: "call-raw",
        output_index: 0,
        delta: "{\"path\"",
      };
      const fetchMock = vi.fn<typeof fetch>(async () => sse(chunk(rawDelta)));
      const response = await new OpencodeGoResponsesAdapter({ fetch: fetchMock }).stream(request(), {
        apiKey: "opencode-secret",
      });
      if (!response.ok) throw new Error("expected ok");

      expect(await collect(response.events)).toEqual([]);
      const raw = wireLog.read().filter((entry) => entry.event === "opencode-go-responses.wire.event");
      expect(raw).toEqual([expect.objectContaining({ payload: { data: rawDelta } })]);
      expect(JSON.stringify(raw)).not.toContain("opencode-secret");
    } finally {
      wireLog.cleanup();
    }
  });

  it("translates streamed output text into canonical events", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse(
      chunk({ type: "response.created", response: { id: "r1", model: "gpt-5.6-luna", usage: null } }),
      chunk({ type: "response.output_text.delta", item_id: "m1", output_index: 0, content_index: 0, delta: "Hel" }),
      chunk({ type: "response.output_text.delta", item_id: "m1", output_index: 0, content_index: 0, delta: "lo" }),
      chunk({ type: "response.output_text.done", item_id: "m1", output_index: 0, content_index: 0, text: "Hello" }),
      chunk({ type: "response.completed", response: { id: "r1", model: "gpt-5.6-luna", usage: { input_tokens: 4, output_tokens: 2 } } }),
    ));
    const response = await new OpencodeGoResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected ok");
    const events = await collect(response.events);
    expect(events[0]).toEqual({
      type: "response.created",
      response: { id: "r1", model: "gpt-5.6-luna", usage: null },
    });
    expect(events
      .filter((event) => event.type === "response.output_text.delta")
      .map((event) => (event.type === "response.output_text.delta" ? event.delta : "")))
      .toEqual(["Hel", "lo"]);
    expect(events.at(-1)).toMatchObject({ type: "response.completed" });
  });

  it("rewrites compatible tool schemas into strict mode and strips the nulls on the way in", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse(
      chunk({ type: "response.created", response: { id: "r1", model: "gpt-5.6-luna", usage: null } }),
      chunk({ type: "response.function_call_arguments.done", item_id: "call-1", output_index: 0, arguments: "{\"path\":\"a.ts\",\"optional\":null}" }),
      chunk({ type: "response.completed", response: { id: "r1", model: "gpt-5.6-luna", usage: { input_tokens: 5, output_tokens: 2 } } }),
    ));
    const response = await new OpencodeGoResponsesAdapter({ fetch: fetchMock }).stream(request({
      tools: [{
        type: "function",
        name: "Read",
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, optional: { type: "string" } },
        },
      }],
    }), { apiKey: "k" });
    if (!response.ok) throw new Error("expected ok");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    const tool = (body.tools as Array<Record<string, unknown>>)[0];
    // Strict rewrite is the same one-mechanism pair here as in the Codex copy:
    // every property required, additionalProperties false, and omitted args become null.
    expect(tool.strict).toBe(true);
    expect(tool.parameters).toEqual({
      type: "object",
      properties: {
        path: { type: ["string", "null"] },
        optional: { type: ["string", "null"] },
      },
      required: ["path", "optional"],
      additionalProperties: false,
    });
    // The nulls strict mode requires are stripped again before reaching the client.
    const events = await collect(response.events);
    const done = events.find((event) => event.type === "response.function_call_arguments.done");
    expect(done).toMatchObject({ arguments: "{\"path\":\"a.ts\"}" });
  });

  it("drops function_call_arguments.delta but forwards the whole done event", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse(
      chunk({ type: "response.created", response: { id: "r1", model: "gpt-5.6-luna", usage: null } }),
      chunk({ type: "response.function_call_arguments.delta", item_id: "call-1", output_index: 0, delta: "{\"pat" }),
      chunk({ type: "response.function_call_arguments.done", item_id: "call-1", output_index: 0, arguments: "{\"path\":\"a.ts\"}" }),
      chunk({ type: "response.completed", response: { id: "r1", model: "gpt-5.6-luna", usage: { input_tokens: 5, output_tokens: 2 } } }),
    ));
    const response = await new OpencodeGoResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected ok");
    const events = await collect(response.events);
    expect(events.some((event) => event.type === "response.function_call_arguments.delta")).toBe(false);
    expect(events.filter((event) => event.type === "response.function_call_arguments.done")).toHaveLength(1);
  });

  it("strips canonical-only input fields from the OpenCode wire body", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    await new OpencodeGoResponsesAdapter({ fetch: fetchMock }).stream(request({
      input: [
        { type: "message", role: "user", content: "hi", reasoning_content: "hidden" },
        {
          type: "function_call_output",
          call_id: "call-1",
          output: "out",
          is_error: true,
          tool_references: ["Read"],
        },
      ],
    }), { apiKey: "k" });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      input: Array<Record<string, unknown>>;
    };
    expect(body.input[0]).toEqual({ type: "message", role: "user", content: "hi" });
    expect(body.input[1]).toEqual({ type: "function_call_output", call_id: "call-1", output: "out" });
  });

  it("merges hosted web search into the OpenCode wire with filters, choice, include, and no max_uses", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    await new OpencodeGoResponsesAdapter({ fetch: fetchMock }).stream(request({
      native_tools: [
        { type: "web_search", allowed_domains: ["example.com"], max_uses: 3, required: true },
      ],
    }), { apiKey: "k" });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.tools).toEqual([{ type: "web_search", filters: { allowed_domains: ["example.com"] } }]);
    expect(body.tool_choice).toEqual({ type: "web_search" });
    expect(body.include).toContain("web_search_call.action.sources");
    expect(JSON.stringify(body.tools)).not.toContain("max_uses");
  });

  it("maps blocked_domains to the OpenCode web search filter and dedupes include sources", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    const req = {
      ...request({ native_tools: [{ type: "web_search", blocked_domains: ["spam.example"] }] }),
      include: ["web_search_call.action.sources"],
    } as CanonicalResponseRequest;
    await new OpencodeGoResponsesAdapter({ fetch: fetchMock }).stream(req, { apiKey: "k" });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.tools).toEqual([{ type: "web_search", filters: { blocked_domains: ["spam.example"] } }]);
    expect(body.include).toEqual(["web_search_call.action.sources"]);
  });

  it("translates completed web_search_call sources and drops invalid entries", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse(
      chunk({ type: "response.created", response: { id: "r1", model: "gpt-5.6-luna", usage: null } }),
      chunk({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "ws-1",
          type: "web_search_call",
          status: "completed",
          action: {
            type: "web_search",
            query: "fleet",
            sources: [
              { type: "url", url: "https://a.example", title: "A" },
              { url: "" },
              { type: "url" },
              { type: "url", url: "https://b.example" },
            ],
          },
        },
      }),
      chunk({ type: "response.completed", response: { id: "r1", model: "gpt-5.6-luna", usage: { input_tokens: 4, output_tokens: 2 } } }),
    ));
    const response = await new OpencodeGoResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected ok");
    const events = await collect(response.events);
    const done = events.find((event) => event.type === "response.output_item.done") as Extract<
      CanonicalResponseEvent,
      { type: "response.output_item.done" }
    >;
    expect(done.item).toEqual({
      id: "ws-1",
      type: "web_search_call",
      status: "completed",
      action: {
        type: "web_search",
        query: "fleet",
        sources: [
          { type: "url", url: "https://a.example", title: "A" },
          { type: "url", url: "https://b.example" },
        ],
      },
    });
  });

  it("maps full usage details into canonical usage on the OpenCode adapter", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse(
      chunk({ type: "response.created", response: { id: "r1", model: "gpt-5.6-luna", usage: null } }),
      chunk({
        type: "response.completed",
        response: {
          id: "r1",
          model: "gpt-5.6-luna",
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
            output_tokens_details: { reasoning_tokens: 5 },
            total_tokens: 120,
          },
        },
      }),
    ));
    const response = await new OpencodeGoResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected ok");
    const events = await collect(response.events);
    const completed = events.find((event) => event.type === "response.completed");
    expect(completed).toMatchObject({
      response: {
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cached_input_tokens: 40,
          cache_write_input_tokens: 10,
          reasoning_output_tokens: 5,
          total_tokens: 120,
        },
      },
    });
  });

  it("keeps optional-minimal usage fields absent on the OpenCode adapter", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse(
      chunk({ type: "response.created", response: { id: "r1", model: "gpt-5.6-luna", usage: null } }),
      chunk({ type: "response.completed", response: { id: "r1", model: "gpt-5.6-luna", usage: { input_tokens: 4, output_tokens: 2 } } }),
    ));
    const response = await new OpencodeGoResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected ok");
    const events = await collect(response.events);
    const completed = events.find((event) => event.type === "response.completed");
    expect(completed).toMatchObject({ response: { usage: { input_tokens: 4, output_tokens: 2 } } });
  });

  it("rejects malformed usage on the OpenCode adapter", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse(
      chunk({ type: "response.created", response: { id: "r1", model: "gpt-5.6-luna", usage: null } }),
      chunk({ type: "response.completed", response: { id: "r1", model: "gpt-5.6-luna", usage: { input_tokens: 4, output_tokens: 2, input_tokens_details: { cached_tokens: -1 } } } }),
    ));
    const response = await new OpencodeGoResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected ok");
    await expect(collect(response.events)).rejects.toThrow(/must be a finite nonnegative number/);
  });

  it("translates response.failed and error events on the OpenCode adapter", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse(
      chunk({ type: "response.created", response: { id: "r1", model: "gpt-5.6-luna", usage: null } }),
      chunk({ type: "response.failed", response: { id: "r1", model: "gpt-5.6-luna", error: { type: "server_error", message: "boom" } } }),
      chunk({ type: "error", error: { type: "api_error", message: "wire" } }),
    ));
    const response = await new OpencodeGoResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected ok");
    const events = await collect(response.events);
    expect(events.at(-2)).toEqual({
      type: "response.failed",
      response: { id: "r1", model: "gpt-5.6-luna", usage: null, error: { type: "server_error", message: "boom" } },
    });
    expect(events.at(-1)).toEqual({ type: "error", error: { type: "api_error", message: "wire" } });
  });

  it("rejects invalid JSON in the OpenCode SSE stream", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      "data: {not-json\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const response = await new OpencodeGoResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected ok");
    await expect(collect(response.events)).rejects.toThrow(/invalid JSON/);
  });

  it("rejects a missing streaming body on the OpenCode adapter", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      null,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const response = await new OpencodeGoResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected ok");
    await expect(collect(response.events)).rejects.toThrow(/had no body/);
  });

  it("strips nested object nulls while keeping array null elements on the OpenCode adapter", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse(
      chunk({ type: "response.created", response: { id: "r1", model: "gpt-5.6-luna", usage: null } }),
      chunk({ type: "response.function_call_arguments.done", item_id: "call-1", output_index: 0, arguments: "{\"a\":{\"b\":null},\"arr\":[null,{\"c\":null}]}" }),
      chunk({ type: "response.completed", response: { id: "r1", model: "gpt-5.6-luna", usage: { input_tokens: 5, output_tokens: 2 } } }),
    ));
    const response = await new OpencodeGoResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected ok");
    const events = await collect(response.events);
    const done = events.find((event) => event.type === "response.function_call_arguments.done");
    expect(done).toMatchObject({ arguments: "{\"a\":{},\"arr\":[null,{}]}" });
  });

  it("enforces the OpenCode upstream body byte ceiling", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      "data: {\"a\":\"x\"}\n\n".repeat(100),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const response = await new OpencodeGoResponsesAdapter({ fetch: fetchMock, maxBodyBytes: 32 }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected ok");
    await expect(collect(response.events)).rejects.toThrow(/exceeded/);
  });

  it("enforces the OpenCode upstream idle timeout", async () => {
    const stallBody = new ReadableStream<Uint8Array>({ start() { /* never emit */ } });
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      stallBody,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const response = await new OpencodeGoResponsesAdapter({ fetch: fetchMock, idleTimeoutMs: 50 }).stream(request(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected ok");
    await expect(collect(response.events)).rejects.toThrow(/idle for/);
  });

  it("propagates a caller abort on the OpenCode adapter", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.signal?.aborted) throw new DOMException("cancelled", "AbortError");
      return sse("data: [DONE]\n\n");
    });
    controller.abort();
    await expect(
      new OpencodeGoResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "k", signal: controller.signal }),
    ).rejects.toThrow();
  });

  it("validates explicit zero limits on the OpenCode adapter", () => {
    expect(() => new OpencodeGoResponsesAdapter({ maxBodyBytes: 0 })).toThrow(TypeError);
    expect(() => new OpencodeGoResponsesAdapter({ idleTimeoutMs: 0 })).toThrow(TypeError);
  });
});
