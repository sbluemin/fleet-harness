import { describe, expect, it, vi } from "vitest";

import {
  CodexResponsesAdapter,
  compactCodexConversation,
  type CanonicalResponseRequest,
} from "../../../src/index.js";

function request(): CanonicalResponseRequest {
  return {
    model: "gpt-5.6-luna",
    input: [
      { type: "message", role: "user", content: "Remember CANARY-1" },
      { type: "message", role: "assistant", content: "Stored CANARY-1" },
      { type: "message", role: "user", content: "Continue" },
    ],
    instructions: "base instructions",
    metadata: { user_id: "session-1" },
    reasoning: { summary: "auto", effort: "high" },
    stream: true,
  };
}

function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function created(id: string) {
  return { type: "response.created", response: { id, model: "gpt-5.6-luna", usage: null } };
}

function completed(id: string) {
  return {
    type: "response.completed",
    response: { id, model: "gpt-5.6-luna", usage: { input_tokens: 10, output_tokens: 5 } },
  };
}

describe("Codex conversation compaction", () => {
  it("uses the v2 trigger, renders the opaque item, and preserves compact instructions", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sse([
        created("compact-response"),
        {
          type: "response.output_item.done",
          output_index: 0,
          item: { type: "compaction", encrypted_content: "opaque-compact" },
        },
        completed("compact-response"),
      ]))
      .mockResolvedValueOnce(sse([
        created("summary-response"),
        { type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: "CANARY-1 summary" },
        completed("summary-response"),
      ]));
    const adapter = new CodexResponsesAdapter({ fetch: fetchMock });

    const result = await compactCodexConversation({
      adapter,
      request: request(),
      call: { apiKey: "test" },
      customInstructions: "Preserve DIRECTIVE-1",
      supportedEfforts: ["low", "medium", "high"],
    });

    expect(result).toMatchObject({
      encryptedContent: "opaque-compact",
      nativeCompaction: true,
      summary: "CANARY-1 summary",
      summaryResponse: { id: "summary-response" },
    });
    const compactBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(compactBody.input.at(-1)).toEqual({ type: "compaction_trigger" });
    expect(compactBody.instructions).toContain("Preserve DIRECTIVE-1");
    const summaryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(summaryBody.input[0]).toEqual({ type: "compaction", encrypted_content: "opaque-compact" });
  });

  it("falls back to a dedicated plaintext summarizer when native compaction fails", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"error":{"message":"unsupported"}}', { status: 400 }))
      .mockResolvedValueOnce(sse([
        created("fallback-response"),
        { type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: "CANARY-1 fallback" },
        completed("fallback-response"),
      ]));
    const adapter = new CodexResponsesAdapter({ fetch: fetchMock });

    const result = await compactCodexConversation({
      adapter,
      request: request(),
      call: { apiKey: "test" },
      customInstructions: "Preserve DIRECTIVE-1",
      supportedEfforts: ["low", "medium", "high"],
    });

    expect(result).toMatchObject({
      nativeCompaction: false,
      summary: "CANARY-1 fallback",
    });
    expect(result).not.toHaveProperty("encryptedContent");
    const fallbackBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(JSON.stringify(fallbackBody.input)).toContain("Additional compact instructions");
    expect(JSON.stringify(fallbackBody.input)).toContain("Preserve DIRECTIVE-1");
  });

  it("rejects a native stream with zero or multiple compaction items and uses fallback", async () => {
    for (const count of [0, 2]) {
      const compactItems = Array.from({ length: count }, (_, index) => ({
        type: "response.output_item.done",
        output_index: index,
        item: { type: "compaction", encrypted_content: `opaque-${index}` },
      }));
      const fetchMock = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(sse([created("bad"), ...compactItems, completed("bad")]))
        .mockResolvedValueOnce(sse([
          created("fallback"),
          { type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: "fallback" },
          completed("fallback"),
        ]));

      const result = await compactCodexConversation({
        adapter: new CodexResponsesAdapter({ fetch: fetchMock }),
        request: request(),
        call: { apiKey: "test" },
        supportedEfforts: ["low", "medium", "high"],
      });
      expect(result.nativeCompaction).toBe(false);
      expect(result.summary).toBe("fallback");
    }
  });
});
