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

  it("sends requests to OPENCODE_GO_RESPONSES_URL with Bearer auth by default", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse("data: [DONE]\n\n"));
    await new OpencodeGoResponsesAdapter({ fetch: fetchMock }).stream(request(), { apiKey: "sk-go" });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(OPENCODE_GO_RESPONSES_URL);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-go");
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
});
