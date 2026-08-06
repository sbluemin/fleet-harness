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

  it("validates explicit zero limits instead of silently accepting them", () => {
    expect(() => new CodexResponsesAdapter({ maxBodyBytes: 0 })).toThrow(TypeError);
    expect(() => new CodexResponsesAdapter({ idleTimeoutMs: 0 })).toThrow(TypeError);
  });
});
