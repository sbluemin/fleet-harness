import { describe, expect, it, vi } from "vitest";

import type { CanonicalResponseEvent, CanonicalResponseRequest } from "../../src/canonical/index.js";
import type { GeminiUsagePort } from "../../src/quota/gemini-usage.js";
import { createGeminiAdapter } from "../../src/upstream/gemini/adapter.js";
import { GEMINI_AUTH_PROVIDER_ID } from "../../src/upstream/gemini/coordinates.js";
import { validateGeminiApiKey } from "../../src/upstream/gemini/probe.js";
import { createGeminiSignatureLedger } from "../../src/upstream/gemini/wire.js";

// 2026-11-18 사령관 실측 형태: usageMetadata는 매 청크에 누적값이고, 마지막 청크는 서명을 실은 빈 텍스트 파트다.
const SIGNATURE = "EsMCCsAC".padEnd(120, "AbC+/9=");
const MODEL = "gemini-4-hydrogen";
const KEY = "test-key-not-real";

function sse(...chunks: unknown[]): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function request(overrides: Partial<CanonicalResponseRequest> = {}): CanonicalResponseRequest {
  return { model: MODEL, input: [{ type: "message", role: "user", content: "hi" }], stream: true, ...overrides };
}

function usagePort(): { port: GeminiUsagePort; usage: ReturnType<typeof vi.fn>; block: ReturnType<typeof vi.fn> } {
  const usage = vi.fn();
  const block = vi.fn();
  return { port: { observeUsage: usage, observeBlock: block }, usage, block };
}

async function collect(events: AsyncIterable<CanonicalResponseEvent>): Promise<CanonicalResponseEvent[]> {
  const collected: CanonicalResponseEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("Gemini upstream", () => {
  it("streams to canonical events, keeps the thought signature, and reports the last cumulative usage once", async () => {
    const { port, usage, block } = usagePort();
    const fetchMock = vi.fn<typeof fetch>(async () => sse(
      {
        candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, index: 0 }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 1, totalTokenCount: 33, thoughtsTokenCount: 25, serviceTier: "standard" },
        modelVersion: MODEL,
        responseId: "r1",
      },
      {
        candidates: [{ content: { role: "model", parts: [{ text: "", thoughtSignature: SIGNATURE }] }, finishReason: "STOP", index: 0 }],
        usageMetadata: { promptTokenCount: 38, candidatesTokenCount: 5, totalTokenCount: 68, thoughtsTokenCount: 25, serviceTier: "standard" },
      },
    ));
    const response = await createGeminiAdapter({ fetch: fetchMock, usage: port }).stream(
      request({ instructions: "be brief", max_output_tokens: 128_000, reasoning: { summary: "auto", effort: "xhigh" } }),
      { apiKey: KEY },
    );
    if (!response.ok) throw new Error("expected a streaming response");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`);
    expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    // 등급은 요청 최상위의 소문자 standard로 늘 명시한다.
    expect(body).toMatchObject({ serviceTier: "standard" });
    expect(body.generationConfig).not.toHaveProperty("serviceTier");
    expect(body).toMatchObject({
      systemInstruction: { parts: [{ text: "be brief" }] },
      // 모델 출력 상한(hydrogen 65536)으로 줄이고, 생각 요약을 켠다.
      generationConfig: { maxOutputTokens: 65_536, thinkingConfig: { thinkingLevel: "xhigh", includeThoughts: true } },
    });
    expect(JSON.stringify(body)).not.toContain(KEY);

    const events = await collect(response.events);
    expect(events.filter((event) => event.type === "response.output_text.delta")).toMatchObject([{ delta: "ok" }]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "response.output_item.done",
      item: expect.objectContaining({ type: "reasoning", encrypted_content: SIGNATURE, origin: "gemini" }),
    }));
    // 누적값의 마지막만: 합산하면 prompt가 45가 된다.
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      response: { usage: { input_tokens: 38, output_tokens: 30, reasoning_output_tokens: 25 } },
    });
    expect(usage).toHaveBeenCalledTimes(1);
    expect(usage).toHaveBeenCalledWith(expect.objectContaining({
      model: MODEL,
      serviceTier: "standard",
      promptTokens: 38,
      cachedTokens: 0,
      candidatesTokens: 5,
      thoughtsTokens: 25,
    }));
    expect(block).not.toHaveBeenCalled();
  });

  it("returns the signature on the function call it was issued for and sends no foreign blob", async () => {
    const ledger = createGeminiSignatureLedger();
    const fetchMock = vi.fn<typeof fetch>(async () => sse({ candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }] }));
    const call = (id: string, reasoning: Record<string, string>) => ({
      type: "function_call" as const,
      call_id: id,
      name: "mcp__linear__create_issue",
      arguments: "{\"title\":\"x\"}",
      ...reasoning,
    });
    await createGeminiAdapter({ fetch: fetchMock, signatureLedger: ledger }).stream(request({
      input: [
        { type: "message", role: "user", content: "go" },
        call("c1", { reasoning_encrypted: SIGNATURE, reasoning_origin: "gemini" }),
        { type: "function_call_output", call_id: "c1", output: "ok" },
        // 다른 공급자가 발행한 blob은 형태가 그럴듯해도 보내지 않는다.
        call("c2", { reasoning_encrypted: SIGNATURE, reasoning_origin: "codex" }),
        { type: "function_call_output", call_id: "c2", output: "ok" },
      ],
    }), { apiKey: KEY });

    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };
    const calls = sent.contents.flatMap((content) => content.parts).filter((part) => part.functionCall !== undefined);
    expect(calls[0]).toMatchObject({ thoughtSignature: SIGNATURE });
    expect(calls[1]).not.toHaveProperty("thoughtSignature");
    // 도구 이름은 와이어 문법(64자·허용 문자)에 맞게 바뀌고, 응답 결과는 그 이름으로 이어진다.
    const wireName = (calls[0]!.functionCall as { name: string }).name;
    expect(wireName).toMatch(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/);
    expect(sent.contents.flatMap((content) => content.parts).find((part) => part.functionResponse !== undefined))
      .toMatchObject({ functionResponse: { name: wireName, id: "c1" } });
  });

  it("reports 402 and 429 blocks (HTTP and mid-stream) and reads an invalid key as a sign-in failure", async () => {
    const { port, usage, block } = usagePort();
    const failure = (status: number, error: Record<string, unknown>) =>
      new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });

    const depleted = await createGeminiAdapter({ fetch: async () => failure(402, { code: "payment_required", message: "Prepay credit balance is depleted" }), usage: port })
      .stream(request(), { apiKey: KEY });
    expect(depleted).toMatchObject({ ok: false, status: 402 });
    expect(block).toHaveBeenLastCalledWith(expect.objectContaining({
      model: MODEL, httpStatus: 402, reason: "balance_depleted", code: "payment_required",
    }));

    // 스트림이 이미 200으로 시작한 뒤의 RESOURCE_EXHAUSTED.
    const midStream = await createGeminiAdapter({
      fetch: async () => sse({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "spend limit" } }),
      usage: port,
    }).stream(request(), { apiKey: KEY });
    if (!midStream.ok) throw new Error("expected a streaming response");
    const events = await collect(midStream.events);
    expect(events.at(-1)).toMatchObject({ type: "response.failed", response: { error: { type: "rate_limit_error" } } });
    expect(block).toHaveBeenLastCalledWith(expect.objectContaining({
      httpStatus: 429, reason: "rate_limited", code: "RESOURCE_EXHAUSTED",
    }));

    // 다른 상태 코드와 잘못된 키는 차단이 아니다. 잘못된 키는 400 API_KEY_INVALID로 오고 401로 올라간다.
    block.mockClear();
    const invalid = await createGeminiAdapter({
      fetch: async () => failure(400, { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid.", details: [{ reason: "API_KEY_INVALID" }] }),
      usage: port,
    }).stream(request(), { apiKey: KEY });
    expect(invalid).toMatchObject({ ok: false, status: 401 });
    expect(block).not.toHaveBeenCalled();
    expect(usage).not.toHaveBeenCalled();
  });

  it("rejects only the key failures: 401, 403 and a 400 whose reason is API_KEY_INVALID", async () => {
    const probe = async (status: number, body: unknown) => {
      const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
      vi.stubGlobal("fetch", fetchMock);
      try {
        return { result: await validateGeminiApiKey({ providerId: GEMINI_AUTH_PROVIDER_ID, apiKey: KEY }), fetchMock };
      } finally {
        vi.unstubAllGlobals();
      }
    };
    const invalidKey = { error: { code: 400, status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } };
    const ok = await probe(200, { models: [] });
    expect(ok.result.status).toBe("success");
    expect(ok.fetchMock.mock.calls[0]?.[0]).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(ok.fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
    expect((await probe(400, invalidKey)).result.status).toBe("unauthorized");
    expect((await probe(401, {})).result.status).toBe("unauthorized");
    expect((await probe(403, {})).result.status).toBe("forbidden");
    // 다른 400은 키 거절이 아니다.
    expect((await probe(400, { error: { code: 400, status: "INVALID_ARGUMENT", details: [{ reason: "OTHER" }] } })).result.status).toBe("unknown");
    expect((await validateGeminiApiKey({ providerId: GEMINI_AUTH_PROVIDER_ID, apiKey: "  " })).status).toBe("unauthorized");
  });
});
