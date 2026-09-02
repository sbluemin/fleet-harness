import {
  AnthropicMessagesGateway,
  CURSOR_TOOL_BYTES_LIMIT,
  createClaudeCodexCompactionStore,
  ContextWindowExceededError,
  CursorAdapter,
  CLAUDE_COMPACT_CONTINUATION_MARKER,
  CLAUDE_COMPACT_PROMPT_MARKER,
} from "../../src/index.js";
import type {
  AdapterResponse,
  AiGatewayAdapter,
  AiGatewayStoredSettings,
  AnthropicMessagesRequest,
  CanonicalResponseRequest,
} from "../../src/index.js";
import type { GatewayFailureRecord } from "../../src/index.js";
import type { GatewayHttpHandlerContext } from "../../src/router/types.js";
import { createHash } from "node:crypto";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  KIMI_MESSAGES_URL,
  MAX_GATEWAY_REQUEST_BODY_BYTES,
  OPENCODE_MESSAGES_URL,
  XAI_CLI_RESPONSES_URL,
  XAI_RESPONSES_URL,
  createAiGatewayRouter as createCoreAiGatewayRouter,
  errorMessage,
} from "../../src/index.js";
import type { AiGatewayRouteDeps } from "../../src/index.js";
import { wireLogFixture } from "../helpers/wire-log.js";

function aiGatewaySettingsStub(settings: AiGatewayStoredSettings): () => AiGatewayStoredSettings {
  return () => settings;
}

const BASE = "/plugins/terminal/ai-gateway";
const MESSAGES = `${BASE}/v1/messages`;
const ANTHROPIC_CRED = "sk-ant-oat01-caller";
const SUBSCRIPTION_TOKEN = "chatgpt-subscription-access-token";
const ACCOUNT_ID = "11111111-2222-3333-4444-555555555555";

/** Claude Code's shell-first directive as it arrives, with one neighbour on each side. */
/** A caller catalog carrying the tools provider policies decide about. */
const SEARCH_CATALOG = [
  { name: "Read", input_schema: { type: "object", properties: {} } },
  { name: "Grep", input_schema: { type: "object", properties: {} } },
  { name: "Glob", input_schema: { type: "object", properties: {} } },
  { name: "WebSearch", input_schema: { type: "object", properties: { query: { type: "string" } } } },
];

describe("gateway error messages", () => {
  it("includes a transport cause code", () => {
    const error = new TypeError("fetch failed");
    Object.defineProperty(error, "cause", { value: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } });
    expect(errorMessage(error)).toBe("fetch failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE)");
  });

  it("leaves plain errors unchanged", () => {
    expect(errorMessage(new Error("upstream failed"))).toBe("upstream failed");
  });

  it("does not duplicate a code already present in the message", () => {
    const error = new Error("fetch failed (ECONNREFUSED)");
    Object.defineProperty(error, "cause", { value: { code: "ECONNREFUSED" } });
    expect(errorMessage(error)).toBe("fetch failed (ECONNREFUSED)");
  });
});

describe("router lifecycle", () => {
  it("reuses one router-owned Cursor adapter and disposes it explicitly", async () => {
    const adapters: CursorAdapter[] = [];
    const streamSpy = vi.spyOn(CursorAdapter.prototype, "stream").mockImplementation(
      async function (this: CursorAdapter) {
        adapters.push(this);
        return successfulAdapterResponse();
      },
    );
    const disposeSpy = vi.spyOn(CursorAdapter.prototype, "dispose");
    const router = createAiGatewayRouter({
      readAuth,
      readCursorToken: () => "cursor-subscription-token",
    });

    try {
      for (let turn = 0; turn < 2; turn += 1) {
        await router.handle(ctx({
          res: response(),
          token: ANTHROPIC_CRED,
          model: "claude-gateway--cursor--grok-4.5",
        }));
      }
      expect(adapters).toHaveLength(2);
      expect(adapters[0]).toBe(adapters[1]);

      router.dispose();
      expect(disposeSpy).toHaveBeenCalledWith();
    } finally {
      router.dispose();
      streamSpy.mockRestore();
      disposeSpy.mockRestore();
    }
  });

  it("does not dispose provider state when the gateway is injected", () => {
    const disposeSpy = vi.spyOn(CursorAdapter.prototype, "dispose");
    const router = createAiGatewayRouter({ gateway: stubGateway(), readAuth });
    try {
      router.dispose();
      expect(disposeSpy).not.toHaveBeenCalled();
    } finally {
      disposeSpy.mockRestore();
    }
  });
});

describe("Claude Codex compaction routing", () => {
  it("records hook events, compacts the summary request, and replays the opaque item", async () => {
    const stored = new Map<string, any>();
    const pending = new Map<string, any>();
    const compactionStore = {
      path: "/state.json",
      recordPreCompact: ({ sessionId, trigger, customInstructions }: any) => pending.set(sessionId, { trigger, customInstructions, updatedAt: 1 }),
      recordPostCompact: ({ sessionId, summary }: any) => {
        const ready = stored.get(sessionId);
        if (ready) stored.set(sessionId, { ...ready, summary });
      },
      readPending: (sessionId: string) => pending.get(sessionId),
      clearPending: (sessionId: string) => pending.delete(sessionId),
      readReady: (sessionId: string, binding: string) => stored.get(sessionId)?.binding === binding ? stored.get(sessionId) : undefined,
      writeReady: (sessionId: string, ready: any) => stored.set(sessionId, { ...ready, updatedAt: 1 }),
      clear: (sessionId: string) => { pending.delete(sessionId); stored.delete(sessionId); },
    };
    const upstreamBodies: any[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      upstreamBodies.push(body);
      const isCompact = body.input?.at(-1)?.type === "compaction_trigger";
      const isSummary = body.input?.[0]?.type === "compaction" && body.input?.length === 2;
      const events = isCompact
        ? [
            { type: "response.created", response: { id: "compact", model: "gpt-5.6-luna", usage: null } },
            { type: "response.output_item.done", output_index: 0, item: { type: "compaction", encrypted_content: "opaque-state" } },
            { type: "response.completed", response: { id: "compact", model: "gpt-5.6-luna", usage: { input_tokens: 10, output_tokens: 5 } } },
          ]
        : isSummary
          ? [
              { type: "response.created", response: { id: "summary", model: "gpt-5.6-luna", usage: null } },
              { type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: "handoff CANARY" },
              { type: "response.completed", response: { id: "summary", model: "gpt-5.6-luna", usage: { input_tokens: 2, output_tokens: 2 } } },
            ]
          : [
              { type: "response.created", response: { id: "turn", model: "gpt-5.6-luna", usage: null } },
              { type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: "recalled CANARY" },
              { type: "response.completed", response: { id: "turn", model: "gpt-5.6-luna", usage: { input_tokens: 3, output_tokens: 2 } } },
            ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200 });
    });
    const router = createAiGatewayRouter({
      fetch: fetchMock,
      readAuth,
      compactionStore,
      compactionHookToken: "hook-token",
    });
    const userId = JSON.stringify({ session_id: "session-compact" });

    const pre = response();
    await router.handle(ctx({
      res: pre,
      pathname: `${BASE}/v1/compact-events`,
      headers: { "x-fleet-compact-token": "hook-token" },
      rawBody: {
        hook_event_name: "PreCompact",
        session_id: "session-compact",
        trigger: "manual",
        custom_instructions: "Preserve DIRECTIVE",
      },
    }));
    expect(pre.status).toBe(200);

    const compact = response();
    await router.handle(ctx({
      res: compact,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--codex--gpt-5.6-luna",
      metadata: { user_id: userId },
      messages: [
        { role: "user", content: "CANARY" },
        { role: "assistant", content: [{ type: "text", text: "stored" }] },
        { role: "user", content: [{ type: "text", text: `boundary\n\n${CLAUDE_COMPACT_PROMPT_MARKER}` }] },
      ],
    }));
    expect(compact.status).toBe(200);
    expect(compact.headers["content-type"]).toContain("text/event-stream");
    expect(compact.body).toContain("handoff CANARY");
    expect(upstreamBodies[0].input.at(-1)).toEqual({ type: "compaction_trigger" });
    expect(upstreamBodies[0].instructions).toContain("Preserve DIRECTIVE");

    // A response-body retry before PostCompact returns the stored summary and does not
    // spend another provider compaction or summary turn.
    const compactRetry = response();
    await router.handle(ctx({
      res: compactRetry,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--codex--gpt-5.6-luna",
      metadata: { user_id: userId },
      messages: [
        { role: "user", content: "CANARY" },
        { role: "assistant", content: [{ type: "text", text: "stored" }] },
        { role: "user", content: [{ type: "text", text: `boundary\n\n${CLAUDE_COMPACT_PROMPT_MARKER}` }] },
      ],
    }));
    expect(compactRetry.body).toContain("handoff CANARY");
    expect(upstreamBodies).toHaveLength(2);

    const post = response();
    await router.handle(ctx({
      res: post,
      pathname: `${BASE}/v1/compact-events`,
      headers: { "x-fleet-compact-token": "hook-token" },
      rawBody: {
        hook_event_name: "PostCompact",
        session_id: "session-compact",
        trigger: "manual",
        compact_summary: "handoff CANARY",
      },
    }));
    expect(post.status).toBe(200);

    const continuation = response();
    await router.handle(ctx({
      res: continuation,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--codex--gpt-5.6-luna",
      metadata: { user_id: userId },
      messages: [
        { role: "user", content: `${CLAUDE_COMPACT_CONTINUATION_MARKER}\n\nhandoff CANARY` },
        { role: "assistant", content: [{ type: "text", text: "after compact" }] },
        { role: "user", content: "recall" },
      ],
    }));
    expect(continuation.status).toBe(200);
    expect(continuation.body).toContain("recalled CANARY");
    expect(upstreamBodies.at(-1).input[0]).toEqual({ type: "compaction", encrypted_content: "opaque-state" });
    expect(JSON.stringify(upstreamBodies.at(-1).input)).not.toContain(CLAUDE_COMPACT_CONTINUATION_MARKER);
  });

  it("replays a durable checkpoint after the router and store are recreated", async () => {
    const fixture = wireLogFixture("compact-resume-");
    const directory = path.dirname(fixture.path);
    const firstStore = createClaudeCodexCompactionStore({ directory });
    firstStore.writeReady("resumed-session", {
      binding: createHash("sha256")
        .update("fleet:codex-compaction:v1:")
        .update("codex--gpt-5.6-luna")
        .update("\0")
        .update(ACCOUNT_ID)
        .digest("hex"),
      encryptedContent: "durable-opaque",
      summary: "durable summary",
    });
    const bodies: any[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response([
        `data: ${JSON.stringify({ type: "response.created", response: { id: "turn", model: "gpt-5.6-luna", usage: null } })}\n\n`,
        `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: "resumed" })}\n\n`,
        `data: ${JSON.stringify({ type: "response.completed", response: { id: "turn", model: "gpt-5.6-luna", usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
      ].join(""), { status: 200 });
    });
    const router = createAiGatewayRouter({
      fetch: fetchMock,
      readAuth,
      compactionStore: createClaudeCodexCompactionStore({ directory }),
      compactionHookToken: "new-process-token",
    });
    const res = response();
    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--codex--gpt-5.6-luna",
      metadata: { user_id: JSON.stringify({ session_id: "resumed-session" }) },
      messages: [
        { role: "user", content: `${CLAUDE_COMPACT_CONTINUATION_MARKER}\n\ndurable summary` },
        { role: "user", content: "continue after restart" },
      ],
    }));
    expect(res.status).toBe(200);
    expect(bodies[0].input[0]).toEqual({ type: "compaction", encrypted_content: "durable-opaque" });
    fixture.cleanup();
  });

  it("refuses compact events without the process token", async () => {
    const router = createAiGatewayRouter({
      readAuth,
      compactionStore: {} as any,
      compactionHookToken: "hook-token",
    });
    const res = response();
    await router.handle(ctx({
      res,
      pathname: `${BASE}/v1/compact-events`,
      rawBody: { hook_event_name: "PreCompact", session_id: "session", trigger: "auto" },
    }));
    expect(res.status).toBe(401);
  });
});

describe("caller credential", () => {
  it("rejects a request that carries no credential", async () => {
    const router = createAiGatewayRouter({ gateway: stubGateway(), readAuth });
    const res = response();
    await router.handle(ctx({ res }));

    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      type: "error",
      error: { type: "authentication_error", message: "Missing Anthropic credential" },
    });
  });

  it("rejects a bearer that is not an Anthropic credential", async () => {
    const router = createAiGatewayRouter({ gateway: stubGateway(), readAuth });
    const res = response();
    await router.handle(ctx({ res, token: "f".repeat(64) }));

    expect(res.status).toBe(401);
  });

  it("accepts Claude Code's own credential and streams the upstream body through", async () => {
    const router = createAiGatewayRouter({ gateway: stubGateway(), readAuth });
    const res = response();
    await router.handle(ctx({ res, token: ANTHROPIC_CRED }));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("message_stop");
  });

  it("forwards a native Anthropic request with no policy applied", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const router = createAiGatewayRouter({ fetch: fetchMock, readAuth });
    const res = response();
    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-opus-5",
      tools: SEARCH_CATALOG,
    }));

    // 게이트웨이 대상이 없는 요청은 정책을 거치지 않는다. Claude 자신에게 가는
    // 트래픽을 게이트웨이가 다듬으면 클라이언트가 보낸 계약을 우리가 바꾸는 것이다.
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const forwarded = JSON.parse(String(init?.body)) as { tools?: ReadonlyArray<{ name: string }> };
    expect(forwarded.tools?.map((tool) => tool.name)).toEqual(["Read", "Grep", "Glob", "WebSearch"]);
  });

  it("accepts an x-api-key credential too", async () => {
    const router = createAiGatewayRouter({ gateway: stubGateway(), readAuth });
    const res = response();
    await router.handle(ctx({ res, apiKey: ANTHROPIC_CRED }));

    expect(res.status).toBe(200);
  });

});

describe("upstream credential", () => {
  it("refuses to call upstream when no subscription token is present", async () => {
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const router = createAiGatewayRouter({ gateway, readAuth: () => null });
    const res = response();
    await router.handle(ctx({ res, token: ANTHROPIC_CRED }));

    expect(res.status).toBe(401);
    expect(streamSpy).not.toHaveBeenCalled();
    expect(res.body).toContain("codex login");
  });

  it("never echoes the subscription token back to the caller", async () => {
    const router = createAiGatewayRouter({ gateway: stubGateway(), readAuth });
    const res = response();
    await router.handle(ctx({ res, token: ANTHROPIC_CRED }));

    expect(`${JSON.stringify(res.headers)}${res.body}`).not.toContain(SUBSCRIPTION_TOKEN);
  });

  it("passes Codex Fast as a base model with priority service tier", async () => {
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const router = createAiGatewayRouter({ gateway, readAuth });
    const res = response();
    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--codex--gpt-5.6-sol-fast",
    }));

    expect(streamSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      apiKey: SUBSCRIPTION_TOKEN,
      contextWindow: 272_000,
      model: "gpt-5.6-sol",
      serviceTier: "priority",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    }));
  });

  it("withholds Claude Code's Web Search tools from translated providers", async () => {
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const router = createAiGatewayRouter({ gateway, readAuth });
    const res = response();
    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--codex--gpt-5.6-sol-fast",
      tools: [
        { name: "Read", input_schema: { type: "object", properties: {} } },
        { name: "WebSearch", input_schema: { type: "object", properties: { query: { type: "string" } } } },
        { type: "web_search_20250305", name: "web_search" },
      ],
      toolChoice: { type: "tool", name: "web_search" },
      messages: [{
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "WebSearch", input: { query: "x" } }],
      }],
    }));

    expect(res.status).toBe(200);
    const [request] = streamSpy.mock.calls[0] ?? [];
    expect(request?.tools?.map((tool) => tool.name)).toEqual(["Read"]);
    expect(request?.tool_choice).toEqual({ type: "auto" });
    expect(request?.messages).toEqual([{
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "WebSearch", input: { query: "x" } }],
    }]);
  });

  it("withholds Claude Code's Web Search tools from Cursor", async () => {
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const router = createAiGatewayRouter({
      gateway,
      readAuth,
      readCursorToken: () => "cursor-subscription-token",
    });
    const res = response();
    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--cursor--grok-4.5",
      tools: [
        { name: "Read", input_schema: { type: "object", properties: {} } },
        { name: "WebSearch", input_schema: { type: "object", properties: { query: { type: "string" } } } },
        { type: "web_search_20250305", name: "web_search" },
      ],
      toolChoice: { type: "tool", name: "WebSearch" },
    }));

    expect(res.status).toBe(200);
    const [request] = streamSpy.mock.calls[0] ?? [];
    expect(request?.tools?.map((tool) => tool.name)).toEqual(["Read"]);
    expect(request?.tool_choice).toEqual({ type: "auto" });
  });

  // 공급자별 정책 매트릭스는 request-policy.test.ts가 소유한다. 여기서 고정하는 것은
  // 라우터가 그 정책을 *모든 디스패치 분기에서* 실제로 적용한다는 사실뿐이다.
  it("applies the target policy on the gateway-stream branch", async () => {
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const router = createAiGatewayRouter({
      gateway,
      readAuth,
      readCursorToken: () => "cursor-subscription-token",
    });
    const res = response();
    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--cursor--grok-4.5",
      tools: SEARCH_CATALOG,
    }));

    expect(res.status).toBe(200);
    const [request] = streamSpy.mock.calls[0] ?? [];
    expect(request?.tools?.map((tool) => tool.name)).toEqual(["Read", "Grep", "Glob"]);
  });

  it("applies the target's own policy rather than a blanket one", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const router = createAiGatewayRouter({
      fetch: fetchMock,
      readAuth,
      readKimiApiKey: async () => "kimi-secret",
    });
    const res = response();
    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--kimi--k3",
      tools: SEARCH_CATALOG,
    }));

    expect(res.status).toBe(200);
    // Kimi services Web Search itself, so its policy alone keeps that definition.
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const forwarded = JSON.parse(String(init?.body)) as { tools?: ReadonlyArray<{ name: string }> };
    expect(forwarded.tools?.map((tool) => tool.name)).toEqual(["Read", "Grep", "Glob", "WebSearch"]);
  });

  it("applies the target policy before the Grok CLI wire is serialized", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const router = createAiGatewayRouter({
      fetch: fetchMock,
      readAuth,
      readXaiToken: () => "grok-subscription-token",
    });
    const res = response();
    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--xai--grok-4.6",
      tools: SEARCH_CATALOG,
    }));

    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(init?.body)).toContain("\"Grep\"");
    expect(String(init?.body)).not.toContain("WebSearch");
  });

  it("applies the target policy on the Anthropic passthrough branch", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const router = createAiGatewayRouter({
      fetch: fetchMock,
      readAuth,
      readOpencodeApiKey: async () => "opencode-secret",
    });
    const res = response();
    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--opencode--minimax-m3[1m]",
      tools: SEARCH_CATALOG,
    }));

    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(init?.body)).toContain("\"Grep\"");
    expect(String(init?.body)).not.toContain("WebSearch");
  });

  it("projects Codex usage from the registry when Claude strips the 1M marker", async () => {
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const fetchMock = vi.fn<typeof fetch>();
    const router = createAiGatewayRouter({ gateway, fetch: fetchMock, readAuth });
    const res = response();

    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--codex--gpt-5.6-luna",
    }));

    expect(res.status).toBe(200);
    expect(streamSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      contextWindow: 272_000,
    }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clamps an explicit Sol ultra request to the model's max rung", async () => {
    let canonical: CanonicalResponseRequest | undefined;
    const router = createAiGatewayRouter({
      gateway: stubGateway((request) => {
        canonical = request;
      }),
      readAuth,
    });

    await router.handle(ctx({
      res: response(),
      token: ANTHROPIC_CRED,
      model: "claude-gateway--codex--gpt-5.6-sol",
      thinking: { type: "adaptive" },
      outputConfig: { effort: "ultra" },
    }));

    expect(canonical?.model).toBe("gpt-5.6-sol");
    expect(canonical?.reasoning).toEqual({ summary: "auto", effort: "max" });
  });

  it("clamps an explicit Luna ultra request to the model's max rung", async () => {
    let canonical: CanonicalResponseRequest | undefined;
    const router = createAiGatewayRouter({
      gateway: stubGateway((request) => {
        canonical = request;
      }),
      readAuth,
    });

    await router.handle(ctx({
      res: response(),
      token: ANTHROPIC_CRED,
      model: "claude-gateway--codex--gpt-5.6-luna",
      thinking: { type: "adaptive" },
      outputConfig: { effort: "ultra" },
    }));

    expect(canonical?.model).toBe("gpt-5.6-luna");
    expect(canonical?.reasoning).toEqual({ summary: "auto", effort: "max" });
  });

  it("preserves Cursor effort until the adapter resolves its wire model suffix", async () => {
    let canonical: CanonicalResponseRequest | undefined;
    const gateway = stubGateway((request) => {
      canonical = request;
    });
    const streamSpy = vi.spyOn(gateway, "stream");
    const router = createAiGatewayRouter({
      gateway,
      readAuth,
      readCursorToken: () => "cursor-subscription-token",
    });

    await router.handle(ctx({
      res: response(),
      token: ANTHROPIC_CRED,
      model: "claude-gateway--cursor--grok-4.5",
      thinking: { type: "adaptive" },
      outputConfig: { effort: "medium" },
    }));

    expect(canonical?.model).toBe("grok-4.5");
    expect(canonical?.reasoning).toEqual({ summary: "auto", effort: "medium" });
    expect(streamSpy.mock.calls[0]?.[1]).not.toHaveProperty("reasoningEfforts");
  });

  it("routes Cursor Grok 4.6 xhigh to its exact wire model id", async () => {
    let canonical: CanonicalResponseRequest | undefined;
    const gateway = stubGateway((request) => {
      canonical = request;
    });
    const streamSpy = vi.spyOn(gateway, "stream");
    const router = createAiGatewayRouter({
      gateway,
      readAuth,
      readCursorToken: () => "cursor-subscription-token",
    });

    await router.handle(ctx({
      res: response(),
      token: ANTHROPIC_CRED,
      model: "claude-gateway--cursor--grok-4.6",
      thinking: { type: "adaptive" },
      outputConfig: { effort: "xhigh" },
    }));

    expect(canonical?.model).toBe("grok-4.6");
    expect(canonical?.reasoning).toEqual({ summary: "auto", effort: "xhigh" });
    expect(streamSpy.mock.calls[0]?.[1]).not.toHaveProperty("reasoningEfforts");
  });

  // 이 케이스가 보는 것은 진단 옵트인이지만, 설정을 실어 주는 순간 노출 선별도 함께 선다 —
  // 요청하는 모델을 켜 두지 않으면 진단 단언에 닿기 전에 실행이 거절된다.
  it.each([
    [{ version: 1, models: [{ id: "cursor--grok-4.5-fast" }] } satisfies AiGatewayStoredSettings, false],
    [{ version: 1, models: [{ id: "cursor--grok-4.5-fast" }], cursorDiagnosticsEnabled: true, wireLogEnabled: false } satisfies AiGatewayStoredSettings, true],
  ])("passes stored Cursor diagnostics opt-in %s to newly started traces", async (settings, expected) => {
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const router = createAiGatewayRouter({
      gateway,
      readAiGatewaySettings: aiGatewaySettingsStub(settings),
      readAuth,
      readCursorToken: () => "cursor-subscription-token",
    });

    await router.handle(ctx({
      res: response(),
      token: ANTHROPIC_CRED,
      model: "claude-gateway--cursor--grok-4.5-fast",
    }));

    expect(streamSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      diagnosticsEnabled: expected,
    }));
  });

  it("preserves the package default when no Console settings reader is injected", async () => {
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const router = createAiGatewayRouter({
      gateway,
      readAuth,
      readCursorToken: () => "cursor-subscription-token",
    });

    await router.handle(ctx({
      res: response(),
      token: ANTHROPIC_CRED,
      model: "claude-gateway--cursor--grok-4.5-fast",
    }));

    expect(streamSpy.mock.calls[0]?.[1]).not.toHaveProperty("diagnosticsEnabled");
  });

  it("fails closed for diagnostics without blocking Cursor when settings cannot be read", async () => {
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const router = createAiGatewayRouter({
      gateway,
      readAiGatewaySettings: () => { throw new Error("settings unavailable"); },
      readAuth,
      readCursorToken: () => "cursor-subscription-token",
    });
    const res = response();

    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--cursor--grok-4.5-fast",
    }));

    expect(res.status).toBe(200);
    expect(streamSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      diagnosticsEnabled: false,
    }));
  });

  it("projects Cursor usage from the registry when Claude strips the 1M marker", async () => {
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const router = createAiGatewayRouter({
      gateway,
      readAuth,
      readCursorToken: () => "cursor-subscription-token",
    });

    await router.handle(ctx({
      res: response(),
      token: ANTHROPIC_CRED,
      model: "claude-gateway--cursor--grok-4.5-fast",
    }));

    expect(streamSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      contextWindow: 256_000,
    }));
  });

  it.each([
    ["claude-gateway--codex--gpt-5.6-sol", "codex"],
    ["claude-gateway--opencode--deepseek-v4-flash", "opencode responses"],
  ])("routes the %s translated adapter through the upstream gate", async (model) => {
    // An adapter built without a fetch falls back to globalThis.fetch, which opens sockets the
    // router neither bounds nor counts — the provider escapes the ceiling this router imposes.
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"output\":[]}}\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const router = createAiGatewayRouter({
      fetch: fetchMock,
      readAuth,
      readOpencodeApiKey: async () => "opencode-secret",
    });

    await router.handle(ctx({ res: response(), token: ANTHROPIC_CRED, model }));

    expect(fetchMock).toHaveBeenCalled();
    router.dispose();
  });

  it("bounds concurrent upstream calls per origin and reports occupancy", async () => {
    let open!: ReadableStreamDefaultController<Uint8Array>;
    const held = new ReadableStream<Uint8Array>({ start(c) { open = c; } });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(held, {
        status: 200, headers: { "content-type": "text/event-stream" },
      }))
      .mockResolvedValue(new Response("event: message_stop\n\n", {
        status: 200, headers: { "content-type": "text/event-stream" },
      }));
    const router = createAiGatewayRouter({
      fetch: fetchMock,
      readAuth,
      readKimiApiKey: async () => "kimi-secret",
      maxUpstreamInFlight: 1,
    });

    const settle = async (): Promise<void> => {
      for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    const first = router.handle(ctx({
      res: response(), token: ANTHROPIC_CRED, model: "claude-gateway--kimi--k3[1m]",
    }));
    await settle();

    // The first turn's stream is still open, so its socket is still counted.
    expect(router.upstreamStats()).toEqual([
      expect.objectContaining({ inFlight: 1, queued: 0 }),
    ]);

    const second = router.handle(ctx({
      res: response(), token: ANTHROPIC_CRED, model: "claude-gateway--kimi--k3[1m]",
    }));
    await settle();

    // Second turn waits for a permit rather than opening a second socket.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    open.close();
    await first;
    await second;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    router.dispose();
  });

  it("journals a failed turn with its phase, cause, and upstream occupancy", async () => {
    const records: GatewayFailureRecord[] = [];
    const gateway = {
      stream: async () => {
        const error = new TypeError("fetch failed");
        Object.defineProperty(error, "cause", { value: { code: "UND_ERR_SOCKET" } });
        throw error;
      },
    } as unknown as AnthropicMessagesGateway;
    const router = createAiGatewayRouter({
      gateway,
      readAuth,
      failureJournal: (entry) => records.push(entry),
    });

    await router.handle(ctx({ res: response(), token: ANTHROPIC_CRED }));

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      phase: "pre_commit",
      status: 500,
      errorType: "api_error",
      code: "UND_ERR_SOCKET",
      provider: "codex",
    });
    expect(records[0]!.detail).toContain("UND_ERR_SOCKET");
    expect(typeof records[0]!.elapsedMs).toBe("number");
  });

  it("completes the client response even when the journal sink throws", async () => {
    // The journal is an observation surface. A host sink that throws must not replace the failure
    // it was recording and leave the client with no response at all.
    const gateway = {
      stream: async () => { throw new Error("upstream died"); },
    } as unknown as AnthropicMessagesGateway;
    const router = createAiGatewayRouter({
      gateway,
      readAuth,
      failureJournal: () => { throw new Error("sink exploded"); },
    });
    const res = response();

    await expect(router.handle(ctx({ res, token: ANTHROPIC_CRED }))).resolves.toBe(true);
    expect(res.status).toBe(500);
    expect(res.body).toContain("upstream died");
  });

  it("keeps a caller mistake out of the transient class it journals", async () => {
    const records: GatewayFailureRecord[] = [];
    const gateway = {
      stream: async () => { throw new ContextWindowExceededError(300_000, 200_000); },
    } as unknown as AnthropicMessagesGateway;
    const router = createAiGatewayRouter({
      gateway,
      readAuth,
      failureJournal: (entry) => records.push(entry),
    });

    await router.handle(ctx({ res: response(), token: ANTHROPIC_CRED }));

    expect(records[0]).toMatchObject({ status: 413, errorType: "invalid_request_error" });
  });

  it("reports a transient gateway fault as a status Claude Code retries", async () => {
    // 502 is absent from the client's retry list, so a dropped upstream socket used to end the
    // turn on the first attempt instead of reaching the 10-attempt budget.
    const gateway = {
      stream: async () => {
        const error = new TypeError("fetch failed");
        Object.defineProperty(error, "cause", { value: { code: "UND_ERR_SOCKET" } });
        throw error;
      },
    } as unknown as AnthropicMessagesGateway;
    const router = createAiGatewayRouter({ gateway, readAuth });
    const res = response();

    await router.handle(ctx({ res, token: ANTHROPIC_CRED }));

    expect(res.status).toBe(500);
    expect(res.body).toContain("UND_ERR_SOCKET");
  });

  it("keeps a caller mistake on its own status", async () => {
    const gateway = {
      stream: async () => {
        throw new ContextWindowExceededError(300_000, 200_000);
      },
    } as unknown as AnthropicMessagesGateway;
    const router = createAiGatewayRouter({ gateway, readAuth });
    const res = response();

    await router.handle(ctx({ res, token: ANTHROPIC_CRED }));

    expect(res.status).toBe(413);
  });

  it("lifts a passthrough upstream 503 onto overloaded_error with its body intact", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ type: "error", error: { type: "api_error", message: "upstream said no" } }),
      { status: 503, headers: { "content-type": "application/json" } },
    ));
    const router = createAiGatewayRouter({
      fetch: fetchMock,
      readAuth,
      readKimiApiKey: async () => "kimi-secret",
    });
    const res = response();

    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--kimi--k3[1m]",
    }));

    expect(res.status).toBe(529);
    // The wording has to survive: the client's retry detection reads the upstream's own text.
    expect(res.body).toContain("upstream said no");
  });

  it("rejects a removed Cursor model instead of forwarding it to Anthropic", async () => {
    const router = createAiGatewayRouter({
      readAuth,
      readCursorToken: () => "cursor-subscription-token",
    });
    const res = response();

    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--cursor--glm-5.2",
      thinking: { type: "adaptive" },
      outputConfig: { effort: "medium" },
    }));

    expect(res.status).toBe(400);
    expect(res.body).toContain("Unknown AI gateway model");
  });

  it("rejects a Cursor request that omits metadata.user_id", async () => {
    const router = createAiGatewayRouter({
      readAuth,
      readCursorToken: () => "cursor-subscription-token",
    });
    const res = response();

    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--cursor--grok-4.5",
      metadata: null,
    }));

    expect(res.status).toBe(400);
    expect(res.body).toContain("metadata.user_id");
  });

  // A Cursor budget refusal is not a context overflow. It has to stay 400: 413 is the
  // shape Claude Code arms reactive compaction from, and compacting cannot make an
  // unfittable tool schema fit, so reporting one as the other sends the client
  // shrinking the wrong thing.
  it("keeps a Cursor transport-budget refusal at 400 rather than the 413 overflow shape", async () => {
    const router = createAiGatewayRouter({
      readAuth,
      readCursorToken: () => "cursor-subscription-token",
    });
    const res = response();

    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--cursor--grok-4.5-fast",
      tools: [{
        name: "selected",
        description: "x".repeat(CURSOR_TOOL_BYTES_LIMIT),
        input_schema: { type: "object", properties: {} },
      }],
      toolChoice: { type: "tool", name: "selected" },
    }));

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: expect.stringContaining("exceeds the transport budget"),
      },
    });
  });
});

describe("model context window", () => {
  it.each([
    // The guard and Claude-coordinate projection both take the model's real window.
    // Marker choice only selects Claude's 200k or 1M coordinate.
    ["claude-gateway--codex--gpt-5.6-sol", 272_000],
    ["claude-gateway--codex--gpt-5.6-terra", 272_000],
    ["claude-gateway--codex--gpt-5.6-sol-524k", 524_288],
    ["claude-gateway--codex--gpt-5.6-sol-1m", 1_000_000],
    ["claude-gateway--codex--gpt-5.6-terra-1m", 1_000_000],
    ["claude-gateway--cursor--grok-4.5-fast", 256_000],
    ["claude-gateway--cursor--composer-2.5", 200_000],
  ])("passes %s's real window to both context contracts", async (model, expected) => {
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const router = createAiGatewayRouter({
      gateway,
      readAuth,
      readCursorToken: () => "cursor-subscription-token",
    });

    await router.handle(ctx({ res: response(), token: ANTHROPIC_CRED, model }));

    expect(streamSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      contextWindow: expected,
      modelContextWindow: expected,
    }));
  });

  it("answers a pre-flight overflow with Claude's prompt-too-long contract", async () => {
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const router = createAiGatewayRouter({ gateway, readAuth });
    const res = response();

    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--codex--gpt-5.6-terra",
      // 4 chars/token puts this at ~750_000 tokens against the 272K Terra base model.
      messages: [{ role: "user", content: "x".repeat(3_000_000) }],
    }));

    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: expect.stringMatching(/^Prompt is too long: \d+ tokens > 272000 maximum context window$/),
      },
    });
    // The guard runs inside the gateway, so upstream was still spared the turn.
    expect(streamSpy).toHaveBeenCalledTimes(1);
  });
});

describe("oversized skill payloads", () => {
  const LISTING = [
    "The following skills are available for use with the Skill tool:",
    "",
    "- agent-browser: Browser automation CLI for AI agents.",
    "- claude-api: Reference for the Claude API / Anthropic SDK.",
    "TRIGGER — read BEFORE opening the target file.",
  ].join("\n");
  // 4 chars/token puts this at 150_000 tokens, past the 54_400 one skill may take
  // from a 272_000-token window.
  const BODY = "Base directory for this skill: /tmp/bundled-skills/2.1.222/abc/claude-api\n\n"
    + "x".repeat(600_000);

  function sentText(request: AnthropicMessagesRequest | undefined, index: number): string {
    const content = request?.messages[index]?.content;
    if (typeof content === "string") return content;
    const block = content?.[0];
    return block && "text" in block && typeof block.text === "string" ? block.text : "";
  }

  it("withholds the body before the provider sees it, and delists the skill from then on", async () => {
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const router = createAiGatewayRouter({ gateway, readAuth });
    const listingTurn = { role: "user", content: [{ type: "text", text: LISTING }] };

    await router.handle(ctx({
      res: response(),
      token: ANTHROPIC_CRED,
      model: "claude-gateway--codex--gpt-5.6-terra",
      messages: [listingTurn, { role: "user", content: [{ type: "text", text: BODY }] }],
    }));

    const first = streamSpy.mock.calls[0]?.[0];
    expect(sentText(first, 1)).toMatch(/^\[Fleet AI gateway withheld the "claude-api" skill/);
    expect(sentText(first, 1)).not.toContain("xxxx");
    // The listing loses the entry in the same request that withheld its body.
    expect(sentText(first, 0)).not.toContain("claude-api");
    expect(sentText(first, 0)).toContain("- agent-browser:");

    // A later turn on the same router never carries the entry at all.
    await router.handle(ctx({
      res: response(),
      token: ANTHROPIC_CRED,
      model: "claude-gateway--codex--gpt-5.6-terra",
      messages: [listingTurn],
    }));

    expect(sentText(streamSpy.mock.calls[1]?.[0], 0)).not.toContain("claude-api");
    expect(sentText(streamSpy.mock.calls[1]?.[0], 0)).toContain("- agent-browser:");
  });

  it("passes an ordinary turn through untouched", async () => {
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const router = createAiGatewayRouter({ gateway, readAuth });

    await router.handle(ctx({
      res: response(),
      token: ANTHROPIC_CRED,
      model: "claude-gateway--codex--gpt-5.6-sol",
      messages: [{ role: "user", content: [{ type: "text", text: LISTING }] }],
    }));

    expect(sentText(streamSpy.mock.calls[0]?.[0], 0)).toBe(LISTING);
  });
});

describe("mid-stream failure", () => {
  function failingGateway(error: unknown): AnthropicMessagesGateway {
    return {
      async stream() {
        return {
          status: 200,
          headers: new Headers({ "content-type": "text/event-stream" }),
          body: (async function* () {
            yield new TextEncoder().encode("event: message_start\ndata: {}\n\n");
            throw error;
          })(),
        };
      },
    } as unknown as AnthropicMessagesGateway;
  }

  function errorFrame(body: string): unknown {
    const data = body.split("event: error\ndata: ")[1]?.split("\n\n")[0];
    return JSON.parse(data ?? "null");
  }

  it("emits a terminal SSE error frame instead of a bare end", async () => {
    const router = createAiGatewayRouter({
      gateway: failingGateway(new Error('upstream died: "quoted"\nsecond line')),
      readAuth,
    });
    const res = response();

    await router.handle(ctx({ res, token: ANTHROPIC_CRED }));

    expect(res.status).toBe(200);
    expect(res.body).toContain("event: message_start");
    expect(res.body).toContain("event: error\n");
    // Hand-concatenation would break on the quote and the newline.
    expect(errorFrame(res.body)).toEqual({
      type: "error",
      error: { type: "api_error", message: 'upstream died: "quoted"\nsecond line' },
    });
  });

  it("keeps the error frame out of a truncated passthrough chunk", async () => {
    // Passthrough forwards raw upstream chunks, so the last one can stop mid-frame.
    const truncated = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,'
      + '"delta":{"type":"text_delta","text":"Hel';
    const router = createAiGatewayRouter({
      gateway: {
        async stream() {
          return {
            status: 200,
            headers: new Headers({ "content-type": "text/event-stream" }),
            body: (async function* () {
              yield new TextEncoder().encode(truncated);
              throw new Error("upstream socket reset");
            })(),
          };
        },
      } as unknown as AnthropicMessagesGateway,
      readAuth,
    });
    const res = response();

    await router.handle(ctx({ res, token: ANTHROPIC_CRED }));

    const blocks = res.body.split("\n\n").filter((block) => block.length > 0);
    // Without a leading separator the two would fuse into one unparseable frame.
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe(truncated);
    expect(JSON.parse(blocks[1]?.split("data: ")[1] ?? "null")).toEqual({
      type: "error",
      error: { type: "api_error", message: "upstream socket reset" },
    });
  });

  it("marks a mid-stream context overflow as an invalid request", async () => {
    const router = createAiGatewayRouter({
      gateway: failingGateway(new ContextWindowExceededError(300_000, 272_000)),
      readAuth,
    });
    const res = response();

    await router.handle(ctx({ res, token: ANTHROPIC_CRED }));

    expect(errorFrame(res.body)).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Prompt is too long: 300000 tokens > 272000 maximum context window",
      },
    });
  });
});

describe("OpenCode Go passthrough", () => {
  it("records raw OpenCode Anthropic events without credentials", async () => {
    const wireLog = wireLogFixture("fleet-opencode-anthropic-wire-log-");
    try {
      const upstream = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
      const fetchMock = vi.fn<typeof fetch>(async () => new Response(
        upstream,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ));
      const router = createAiGatewayRouter({
        fetch: fetchMock,
        readAuth,
        readOpencodeApiKey: async () => "opencode-secret",
      });
      const res = response();

      await router.handle(ctx({
        res,
        token: ANTHROPIC_CRED,
        model: "claude-gateway--opencode--minimax-m3[1m]",
      }));

      expect(res.body).toBe(upstream);
      const raw = wireLog.read().filter((entry) => entry.event === "opencode-go-anthropic.wire.event");
      expect(raw).toEqual([expect.objectContaining({
        payload: { event: "message_stop", data: { type: "message_stop" } },
      })]);
      expect(JSON.stringify(raw)).not.toContain("opencode-secret");
      expect(JSON.stringify(raw)).not.toContain(ANTHROPIC_CRED);
    } finally {
      wireLog.cleanup();
    }
  });

  it("rewrites the model, swaps in the stored key, and strips the unadvertised effort", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      "event: message_stop\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const router = createAiGatewayRouter({
      fetch: fetchMock,
      readAuth,
      readOpencodeApiKey: async () => "opencode-secret",
    });
    const res = response();
    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--opencode--minimax-m3[1m]",
      thinking: { type: "adaptive" },
      outputConfig: { effort: "xhigh", retain: "preserved" },
    }));

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(String(url)).toBe(OPENCODE_MESSAGES_URL);
    expect(headers.get("x-api-key")).toBe("opencode-secret");
    expect(headers.get("authorization")).toBeNull();
    // Go 모델별 effort 계약이 문서화되지 않아 effort만 제거하고 나머지는 보존한다.
    expect(body).toMatchObject({
      model: "minimax-m3",
      thinking: { type: "adaptive" },
      output_config: { retain: "preserved" },
    });
    expect((body.output_config as Record<string, unknown>)).not.toHaveProperty("effort");
    expect(`${JSON.stringify(res.headers)}${res.body}`).not.toContain("opencode-secret");
  });

  it("withholds Claude Code's Web Search tools from OpenCode", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      "event: message_stop\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const router = createAiGatewayRouter({
      fetch: fetchMock,
      readAuth,
      readOpencodeApiKey: async () => "opencode-secret",
    });
    await router.handle(ctx({
      res: response(),
      token: ANTHROPIC_CRED,
      model: "claude-gateway--opencode--minimax-m3[1m]",
      tools: [
        { name: "Read", input_schema: { type: "object", properties: {} } },
        { name: "WebSearch", input_schema: { type: "object", properties: { query: { type: "string" } } } },
        { type: "web_search_20250305", name: "web_search" },
      ],
      toolChoice: { type: "tool", name: "WebSearch" },
    }));

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      readonly tools?: ReadonlyArray<{ readonly name?: string }>;
      readonly tool_choice?: { readonly type?: string };
    };
    expect(body.tools?.map((tool) => tool.name)).toEqual(["Read"]);
    expect(body.tool_choice).toEqual({ type: "auto" });
  });

  it("drops output_config entirely when effort was its only field", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      "event: message_stop\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const router = createAiGatewayRouter({
      fetch: fetchMock,
      readAuth,
      readOpencodeApiKey: async () => "opencode-secret",
    });
    await router.handle(ctx({
      res: response(),
      token: ANTHROPIC_CRED,
      model: "claude-gateway--opencode--qwen3.8-max[1m]",
      outputConfig: { effort: "high" },
    }));

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.model).toBe("qwen3.8-max");
    expect(body).not.toHaveProperty("output_config");
  });

  it("refuses an opencode model without a stored key", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const router = createAiGatewayRouter({ fetch: fetchMock, readAuth });
    const res = response();
    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--opencode--minimax-m3[1m]",
    }));

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.body).toContain("OpenCode Go");
  });

  it("routes translated-wire opencode models through the gateway, not the passthrough proxy", async () => {
    // responses/chat wire 모델은 canonical 번역 경로를 타야 한다 — passthrough fetch가
    // 불리면 그 자체가 회귀다.
    const proxyFetch = vi.fn<typeof fetch>();
    const seen: string[] = [];
    const router = createAiGatewayRouter({
      fetch: proxyFetch,
      readAuth,
      readOpencodeApiKey: async () => "opencode-secret",
      gateway: stubGateway((request) => seen.push(request.model)),
    });

    for (const model of [
      "claude-gateway--opencode--gpt-5.6-luna[1m]",
      "claude-gateway--opencode--deepseek-v4-flash[1m]",
    ]) {
      const res = response();
      await router.handle(ctx({ res, token: ANTHROPIC_CRED, model }));
      expect(res.status).toBe(200);
    }

    expect(seen).toEqual(["gpt-5.6-luna", "deepseek-v4-flash"]);
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it("still refuses translated-wire opencode models without a stored key", async () => {
    const router = createAiGatewayRouter({ readAuth, gateway: stubGateway() });
    const res = response();
    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--opencode--gpt-5.6-luna[1m]",
    }));
    expect(res.status).toBe(401);
    expect(res.body).toContain("OpenCode Go");
  });
});

describe("Grok CLI Responses", () => {
  it("routes xAI models through the chat proxy with the reused subscription credential", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const router = createAiGatewayRouter({
      fetch: fetchMock,
      readAuth,
      readXaiToken: () => "grok-subscription-token",
    });
    const res = response();
    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--xai--grok-4.6",
    }));

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(res.status).toBe(200);
    // No stored preference: the default endpoint, and the identity headers it gates on.
    expect(String(url)).toBe(XAI_CLI_RESPONSES_URL);
    expect(headers.get("authorization")).toBe("Bearer grok-subscription-token");
    expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(headers.get("x-grok-model-override")).toBe("grok-4.6");
    expect(body.model).toBe("grok-4.6");
  });

  it("honors a stored direct-endpoint preference", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const router = createAiGatewayRouter({
      fetch: fetchMock,
      readAuth,
      readXaiToken: () => "grok-subscription-token",
      // Settings that name an endpoint must also expose the model: the selection is the
      // spend contract the execution path enforces, not just the discovery list.
      readAiGatewaySettings: () => ({
        version: 1,
        models: [{ id: "xai--grok-4.6" }],
        xaiEndpoint: "direct" as const,
      }),
    });
    const res = response();
    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--xai--grok-4.6",
    }));

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(XAI_RESPONSES_URL);
    expect(new Headers(init?.headers).get("x-xai-token-auth")).toBeNull();
  });

  it("withholds Claude Code's Web Search tools from the Grok CLI wire", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const router = createAiGatewayRouter({
      fetch: fetchMock,
      readAuth,
      readXaiToken: () => "grok-subscription-token",
    });
    await router.handle(ctx({
      res: response(),
      token: ANTHROPIC_CRED,
      model: "claude-gateway--xai--grok-4.6",
      tools: [
        { name: "Read", input_schema: { type: "object", properties: {} } },
        { name: "WebSearch", input_schema: { type: "object", properties: { query: { type: "string" } } } },
        { type: "web_search_20250305", name: "web_search" },
      ],
    }));

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      readonly tools?: ReadonlyArray<{ readonly name?: string; readonly type?: string }>;
    };
    expect(body.tools?.map((tool) => tool.name ?? tool.type)).toEqual(["Read"]);
  });

  it("refuses an xAI model without an active Grok CLI sign-in", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const router = createAiGatewayRouter({ fetch: fetchMock, readAuth });
    const res = response();
    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--xai--grok-4.6",
    }));

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.body).toContain("grok login");
  });
});

describe("Kimi passthrough", () => {
  it("records raw Kimi Anthropic events before model projection", async () => {
    const wireLog = wireLogFixture("fleet-kimi-anthropic-wire-log-");
    try {
      const upstream = [
        "event: message_start\n",
        `data: ${JSON.stringify({
          type: "message_start",
          message: { id: "msg-kimi-raw", model: "k3", usage: { input_tokens: 1, output_tokens: 0 } },
        })}\n\n`,
      ].join("");
      const fetchMock = vi.fn<typeof fetch>(async () => new Response(
        upstream,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ));
      const router = createAiGatewayRouter({
        fetch: fetchMock,
        readAuth,
        readKimiApiKey: async () => "kimi-secret",
      });
      const res = response();

      await router.handle(ctx({
        res,
        token: ANTHROPIC_CRED,
        model: "claude-gateway--kimi--k3[1m]",
      }));

      expect(res.body).toContain('"model":"claude-gateway--kimi--k3[1m]"');
      const raw = wireLog.read().filter((entry) => entry.event === "kimi-anthropic.wire.event");
      expect(raw).toEqual([expect.objectContaining({
        payload: {
          event: "message_start",
          data: {
            type: "message_start",
            message: { id: "msg-kimi-raw", model: "k3", usage: { input_tokens: 1, output_tokens: 0 } },
          },
        },
      })]);
      expect(JSON.stringify(raw)).not.toContain("kimi-secret");
    } finally {
      wireLog.cleanup();
    }
  });

  it("keeps Claude Code's downstream stream alive while the provider is silent", async () => {
    vi.useFakeTimers();
    try {
      let close!: () => void;
      const fetchMock = vi.fn<typeof fetch>(async () => new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            close = () => controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ));
      const router = createAiGatewayRouter({
        fetch: fetchMock,
        readAuth,
        readKimiApiKey: async () => "kimi-secret",
      });
      const res = response();
      const handled = router.handle(ctx({
        res,
        token: ANTHROPIC_CRED,
        model: "claude-gateway--kimi--k3-256k",
      }));
      await vi.advanceTimersByTimeAsync(10_000);

      expect(res.body).toBe(": keep-alive\n\n");
      close();
      await handled;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rewrites the model and replaces caller authentication with the stored Kimi key", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      "event: message_stop\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const router = createAiGatewayRouter({
      fetch: fetchMock,
      readAuth,
      readKimiApiKey: async () => "kimi-secret",
    });
    const res = response();
    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--kimi--k3[1m]",
      thinking: { type: "adaptive" },
      outputConfig: { effort: "xhigh", retain: "preserved" },
    }));

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(String(url)).toBe(KIMI_MESSAGES_URL);
    expect(headers.get("x-api-key")).toBe("kimi-secret");
    expect(headers.get("authorization")).toBeNull();
    expect(body).toMatchObject({
      model: "k3",
      thinking: { type: "adaptive" },
      output_config: { effort: "high", retain: "preserved" },
    });
    expect(`${JSON.stringify(res.headers)}${res.body}`).not.toContain("kimi-secret");
  });

  it("keeps Claude Code deferred tools eager and normalizes ToolSearch references", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      "event: message_stop\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const router = createAiGatewayRouter({
      fetch: fetchMock,
      readAuth,
      readKimiApiKey: async () => "kimi-secret",
    });

    await router.handle(ctx({
      res: response(),
      token: ANTHROPIC_CRED,
      model: "claude-gateway--kimi--k3-256k",
      tools: [
        {
          name: "ToolSearch",
          input_schema: { type: "object", properties: {} },
        },
        {
          name: "mcp__fleet__wiki_read",
          input_schema: { type: "object", properties: {} },
          defer_loading: true,
        },
      ],
      messages: [{
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call-tool-search",
          content: [{
            type: "tool_reference",
            tool_name: "mcp__fleet__wiki_read",
          }],
        }],
      }],
    }));

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      readonly messages?: ReadonlyArray<{ readonly content?: ReadonlyArray<Record<string, unknown>> }>;
      readonly tools?: ReadonlyArray<Record<string, unknown>>;
    };
    expect(body.tools).toHaveLength(2);
    expect(body.tools?.every((tool) => !("defer_loading" in tool))).toBe(true);
    expect(body.messages?.[0]?.content?.[0]).toMatchObject({
      type: "tool_result",
      content: [{ type: "text", text: "Tool available: mcp__fleet__wiki_read" }],
    });
  });

  it("forwards Claude Code's Web Search tools to Kimi unchanged", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      "event: message_stop\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const router = createAiGatewayRouter({
      fetch: fetchMock,
      readAuth,
      readKimiApiKey: async () => "kimi-secret",
    });

    await router.handle(ctx({
      res: response(),
      token: ANTHROPIC_CRED,
      model: "claude-gateway--kimi--k3-256k",
      tools: [
        { name: "Read", input_schema: { type: "object", properties: {} } },
        { name: "WebSearch", input_schema: { type: "object", properties: { query: { type: "string" } } } },
        { type: "web_search_20250305", name: "web_search" },
      ],
    }));

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      readonly tools?: ReadonlyArray<{ readonly name?: string }>;
    };
    expect(body.tools?.map((tool) => tool.name)).toEqual(["Read", "WebSearch", "web_search"]);
  });

  it.each([
    ["low", "low"],
    ["medium", "low"],
    ["high", "high"],
    ["xhigh", "high"],
    ["max", "max"],
    ["ultra", "max"],
  ])("normalizes Claude Code /effort %s to K3 %s", async (effort, expected) => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      "event: message_stop\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const router = createAiGatewayRouter({
      fetch: fetchMock,
      readAuth,
      readKimiApiKey: async () => "kimi-secret",
    });

    await router.handle(ctx({
      res: response(),
      token: ANTHROPIC_CRED,
      model: "claude-gateway--kimi--k3-256k",
      thinking: { type: "adaptive" },
      outputConfig: { effort },
    }));

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      output_config?: { effort?: string };
    };
    expect(body.output_config?.effort).toBe(expected);
  });

  it("rejects a K3 effort below its lowest supported rung", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const router = createAiGatewayRouter({
      fetch: fetchMock,
      readAuth,
      readKimiApiKey: async () => "kimi-secret",
    });
    const res = response();

    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--kimi--k3-256k",
      thinking: { type: "adaptive" },
      outputConfig: { effort: "minimal" },
    }));

    expect(res.status).toBe(400);
    expect(res.body).toContain("no supported reasoning effort at or below");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not contact Kimi without a stored API key", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const router = createAiGatewayRouter({
      fetch: fetchMock,
      readAuth,
      readKimiApiKey: async () => undefined,
    });
    const res = response();
    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--kimi--k3-256k",
    }));

    expect(res.status).toBe(401);
    expect(res.body).toContain("Kimi API key");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("projects sub-1M cache-aware SSE usage onto the 200k coordinate", async () => {
    const upstreamBody = [
      "event: message_start\r\n",
      `data: ${JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_kimi",
          usage: {
            input_tokens: 32_768,
            cache_read_input_tokens: 32_768,
            cache_creation_input_tokens: 0,
            output_tokens: 2,
          },
        },
      })}\r\n\r\n`,
      "event: message_stop\r\n",
      `data: ${JSON.stringify({ type: "message_stop" })}\r\n\r\n`,
    ].join("");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      upstreamBody,
      { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } },
    ));
    const router = createAiGatewayRouter({
      fetch: fetchMock,
      readAuth,
      readKimiApiKey: async () => "kimi-secret",
    });
    const res = response();

    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--kimi--k3-256k",
    }));

    const payload = res.body
      .split(/\r?\n/)
      .find((line) => line.startsWith("data: "))
      ?.slice(6);
    expect(JSON.parse(payload ?? "null")).toMatchObject({
      message: {
        usage: {
          input_tokens: 22_366,
          cache_read_input_tokens: 22_365,
          cache_creation_input_tokens: 0,
          output_tokens: 2,
        },
      },
    });
  });

  it("rewrites the echoed SSE message_start model back to the client-requested id", async () => {
    const upstreamBody = [
      "event: message_start\r\n",
      `data: ${JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_kimi",
          model: "k3",
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      })}\r\n\r\n`,
      "event: message_stop\r\n",
      `data: ${JSON.stringify({ type: "message_stop" })}\r\n\r\n`,
    ].join("");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      upstreamBody,
      { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } },
    ));
    const router = createAiGatewayRouter({
      fetch: fetchMock,
      readAuth,
      readKimiApiKey: async () => "kimi-secret",
    });
    const res = response();

    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--kimi--k3[1m]",
    }));

    const payload = res.body
      .split(/\r?\n/)
      .find((line) => line.startsWith("data: "))
      ?.slice(6);
    expect(JSON.parse(payload ?? "null")).toMatchObject({
      type: "message_start",
      message: {
        id: "msg_kimi",
        model: "claude-gateway--kimi--k3[1m]",
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    });
    // 요청은 여전히 wire id로 나간다.
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { model?: string };
    expect(requestBody.model).toBe("k3");
  });

  it("rewrites the echoed non-streaming JSON model back to the client-requested id", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({
        id: "msg_kimi",
        model: "k3",
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const router = createAiGatewayRouter({
      fetch: fetchMock,
      readAuth,
      readKimiApiKey: async () => "kimi-secret",
    });
    const res = response();

    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--kimi--k3[1m]",
    }));

    expect(JSON.parse(res.body)).toMatchObject({
      id: "msg_kimi",
      model: "claude-gateway--kimi--k3[1m]",
      content: [{ type: "text", text: "done" }],
      usage: { input_tokens: 10, output_tokens: 4 },
    });
  });

  it("rewrites the echoed model even when no context-window projection applies", async () => {
    const upstreamBody = [
      "event: message_start\r\n",
      `data: ${JSON.stringify({
        type: "message_start",
        message: { id: "msg_kimi", model: "k3", usage: { input_tokens: 10, output_tokens: 1 } },
      })}\r\n\r\n`,
    ].join("");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      upstreamBody,
      { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } },
    ));
    const router = createAiGatewayRouter({
      fetch: fetchMock,
      readAuth,
      readKimiApiKey: async () => "kimi-secret",
    });
    const res = response();

    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--kimi--k3-256k",
    }));

    const payload = res.body
      .split(/\r?\n/)
      .find((line) => line.startsWith("data: "))
      ?.slice(6);
    expect(JSON.parse(payload ?? "null")).toMatchObject({
      message: { model: "claude-gateway--kimi--k3-256k" },
    });
  });
});

describe("anthropic passthrough", () => {
  it("records raw native Anthropic events without caller credentials", async () => {
    const wireLog = wireLogFixture("fleet-native-anthropic-wire-log-");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const router = createAiGatewayRouter({ fetch: fetchMock, readAuth });
    try {
      await router.handle(ctx({
        res: response(),
        token: ANTHROPIC_CRED,
        model: "claude-sonnet-4-6",
      }));

      const raw = wireLog.read().filter((entry) => entry.event === "anthropic.wire.event");
      expect(raw).toEqual([expect.objectContaining({
        payload: { event: "message_stop", data: { type: "message_stop" } },
      })]);
      expect(JSON.stringify(raw)).not.toContain(ANTHROPIC_CRED);
    } finally {
      wireLog.cleanup();
    }
  });

  it("keeps Claude Code's downstream stream alive while Anthropic is silent", async () => {
    vi.useFakeTimers();
    try {
      let close!: () => void;
      const fetchMock = vi.fn<typeof fetch>(async () => new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            close = () => controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ));
      const router = createAiGatewayRouter({ fetch: fetchMock, readAuth });
      const res = response();
      const handled = router.handle(ctx({
        res,
        token: ANTHROPIC_CRED,
        model: "claude-opus-4-6",
      }));
      await vi.advanceTimersByTimeAsync(10_000);

      expect(res.body).toBe(": keep-alive\n\n");
      close();
      await handled;
    } finally {
      vi.useRealTimers();
    }
  });

  it("relays a claude model to the Anthropic subscription without translating", async () => {
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("event: message_stop\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const router = createAiGatewayRouter({ gateway, readAuth });
    const res = response();
    await router.handle(ctx({ res, token: ANTHROPIC_CRED, model: "claude-sonnet-4-6" }));

    expect(res.status).toBe(200);
    // 번역 게이트웨이는 건드리지 않는다.
    expect(streamSpy).not.toHaveBeenCalled();
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toContain("api.anthropic.com");
    // 자격증명을 교체하지 않고 호출자 것을 그대로 실어 보낸다.
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${ANTHROPIC_CRED}`);
    fetchSpy.mockRestore();
  });

  it("keeps native Anthropic usage payloads byte-for-byte unchanged", async () => {
    const raw = [
      "event: message_delta\r\n",
      `data: ${JSON.stringify({
        type: "message_delta",
        usage: {
          input_tokens: 17,
          cache_read_input_tokens: 23,
          cache_creation_input_tokens: 5,
          output_tokens: 3,
        },
      })}\r\n\r\n`,
    ].join("");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      raw,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const router = createAiGatewayRouter({ fetch: fetchMock, readAuth });
    const res = response();

    await router.handle(ctx({ res, token: ANTHROPIC_CRED, model: "claude-sonnet-4-6" }));

    expect(res.body).toBe(raw);
  });

  it("refuses a request that carries no Anthropic credential", async () => {
    const router = createAiGatewayRouter({ gateway: stubGateway(), readAuth });
    const res = response();
    await router.handle(ctx({ res, model: "claude-sonnet-4-6" }));

    expect(res.status).toBe(401);
  });

  it("forwards Claude Code's Web Search tools to native Anthropic unchanged", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      "event: message_stop\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const router = createAiGatewayRouter({ fetch: fetchMock, readAuth });
    await router.handle(ctx({
      res: response(),
      token: ANTHROPIC_CRED,
      model: "claude-sonnet-4-6",
      tools: [
        { name: "Read", input_schema: { type: "object", properties: {} } },
        { name: "WebSearch", input_schema: { type: "object", properties: { query: { type: "string" } } } },
        { type: "web_search_20250305", name: "web_search" },
      ],
    }));

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      readonly tools?: ReadonlyArray<{ readonly name?: string; readonly type?: string }>;
    };
    expect(body.tools?.map((tool) => tool.name)).toEqual(["Read", "WebSearch", "web_search"]);
  });

  it("does not rewrite the echoed model on the real-Anthropic path", async () => {
    const raw = [
      "event: message_start\n",
      `data: ${JSON.stringify({
        type: "message_start",
        message: { id: "msg_anthropic", model: "claude-sonnet-4-6" },
      })}\n\n`,
      "event: message_stop\n",
      `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      raw,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const router = createAiGatewayRouter({ fetch: fetchMock, readAuth });
    const res = response();

    await router.handle(ctx({ res, token: ANTHROPIC_CRED, model: "claude-sonnet-4-6" }));

    expect(res.body).toBe(raw);
  });
});

// 선별은 광고 목록이 아니라 지출 계약이다. 디스커버리가 켠 모델만 내놓아도 실행 경로가 카탈로그
// 전체를 받아 주면, raw id를 아는 호출자가 사용자가 끈 모델로 그 구독을 그대로 쓴다.
describe("exposed model selection", () => {
  const ENABLED = "claude-gateway--codex--gpt-5.6-sol";
  const DISABLED = "claude-gateway--codex--gpt-5.6-luna";
  const SELECTION: AiGatewayStoredSettings = { version: 1, models: [{ id: "codex--gpt-5.6-sol" }] };

  it("serves a model the user left enabled", async () => {
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const router = createAiGatewayRouter({
      gateway,
      readAiGatewaySettings: aiGatewaySettingsStub(SELECTION),
      readAuth,
    });
    const res = response();

    await router.handle(ctx({ res, token: ANTHROPIC_CRED, model: ENABLED }));

    expect(res.status).toBe(200);
    expect(streamSpy).toHaveBeenCalled();
  });

  it("refuses a disabled model named by its raw id, without spending the subscription", async () => {
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const authSpy = vi.fn(readAuth);
    const router = createAiGatewayRouter({
      gateway,
      readAiGatewaySettings: aiGatewaySettingsStub(SELECTION),
      readAuth: authSpy,
    });
    const res = response();

    await router.handle(ctx({ res, token: ANTHROPIC_CRED, model: DISABLED }));

    expect(res.status).toBe(403);
    expect(res.body).toContain("not enabled");
    // 거절이 자격증명을 읽기도 전에 끝나야 한다. 구독 토큰을 조달한 뒤 막으면 그만큼은 이미 새어 나간 것이다.
    expect(authSpy).not.toHaveBeenCalled();
    expect(streamSpy).not.toHaveBeenCalled();
  });

  it("keeps discovery and execution agreeing on the same set", async () => {
    const router = createAiGatewayRouter({
      gateway: stubGateway(),
      readAiGatewaySettings: aiGatewaySettingsStub(SELECTION),
      readAuth,
    });
    const discovery = response();
    await router.handle(ctx({ res: discovery, token: ANTHROPIC_CRED, pathname: `${BASE}/v1/models`, method: "GET" }));

    expect(discovery.body).toContain("codex--gpt-5.6-sol");
    expect(discovery.body).not.toContain("codex--gpt-5.6-luna");

    const execution = response();
    await router.handle(ctx({ res: execution, token: ANTHROPIC_CRED, model: DISABLED }));
    expect(execution.status).toBe(403);
  });

  it("exposes the whole catalog when no settings reader is injected", async () => {
    // 리더 미주입은 "선별 없음"이지 "전부 꺼짐"이 아니다 — /v1/models가 이미 그렇게 동작한다.
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const router = createAiGatewayRouter({ gateway, readAuth });
    const res = response();

    await router.handle(ctx({ res, token: ANTHROPIC_CRED, model: DISABLED }));

    expect(res.status).toBe(200);
    expect(streamSpy).toHaveBeenCalled();
  });

  it("lets an operator env override reach a model the selection leaves off", async () => {
    // 그 값을 세팅한 주체는 이 프로세스의 운영자이고 선별 파일의 주인과 같은 사람이라,
    // 호출자 입력과 같은 신뢰 등급이 아니다.
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const router = createAiGatewayRouter({
      gateway,
      readAiGatewaySettings: aiGatewaySettingsStub(SELECTION),
      readAuth,
      readModelOverride: () => DISABLED,
    });
    const res = response();

    await router.handle(ctx({ res, token: ANTHROPIC_CRED, model: ENABLED }));

    expect(res.status).toBe(200);
    expect(streamSpy).toHaveBeenCalled();
  });

  it("does not block a launch when the selection file cannot be read", async () => {
    // 설정 판독 실패는 기능을 낮출 뿐 요청을 막지 않는다 — 위 Cursor 진단이 이미 택한 규율이다.
    const gateway = stubGateway();
    const router = createAiGatewayRouter({
      gateway,
      readAiGatewaySettings: () => { throw new Error("settings unavailable"); },
      readAuth,
    });
    const res = response();

    await router.handle(ctx({ res, token: ANTHROPIC_CRED, model: DISABLED }));

    expect(res.status).toBe(200);
  });

  it("leaves native Anthropic models alone", async () => {
    // 카탈로그에 없는 모델은 게이트웨이 지출이 아니라 호출자 자격증명으로 가는 원문 중계다.
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    const router = createAiGatewayRouter({
      readAiGatewaySettings: aiGatewaySettingsStub(SELECTION),
      readAuth,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const res = response();

    await router.handle(ctx({ res, token: ANTHROPIC_CRED, model: "claude-sonnet-5" }));

    expect(res.status).not.toBe(403);
    expect(fetchImpl).toHaveBeenCalled();
  });
});

describe("request body limit", () => {
  it("refuses a body past the limit with a 413 that does not arm reactive compaction", async () => {
    // "context window"가 들어간 413만 Claude Code의 압축을 무장시킨다(canonical/index.ts).
    // 큰 본문이 곧 창 초과는 아니므로 그 문구를 빌려 쓰지 않는다.
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const router = createAiGatewayRouter({ gateway, readAuth });
    const res = response();

    await router.handle(oversizedCtx(res, MAX_GATEWAY_REQUEST_BODY_BYTES));

    expect(res.status).toBe(413);
    expect(res.body).not.toContain("context window");
    expect(streamSpy).not.toHaveBeenCalled();
  });

  it("stops reading instead of buffering everything the caller offers", async () => {
    // 다 모은 뒤 크기를 재면 이미 그만큼 실린 뒤다. 상한을 넘긴 순간 소비가 끝나야 한다.
    const router = createAiGatewayRouter({ gateway: stubGateway(), readAuth });
    const res = response();
    let yielded = 0;
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    const req = {
      method: "POST",
      headers: { authorization: `Bearer ${ANTHROPIC_CRED}` },
      once: () => undefined,
      off: () => undefined,
      async *[Symbol.asyncIterator]() {
        // 상한의 네 배를 내놓을 준비를 해 두고, 실제로 몇 번 소비되는지 센다.
        for (let i = 0; i < (MAX_GATEWAY_REQUEST_BODY_BYTES / chunk.length) * 4; i += 1) {
          yielded += 1;
          yield chunk;
        }
      },
    };

    await router.handle({ req, res, pathname: MESSAGES } as unknown as GatewayHttpHandlerContext);

    expect(res.status).toBe(413);
    expect(yielded * chunk.length).toBeLessThanOrEqual(MAX_GATEWAY_REQUEST_BODY_BYTES + chunk.length);
  });

  it("admits an ordinary conversation body", async () => {
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const router = createAiGatewayRouter({ gateway, readAuth });
    const res = response();

    await router.handle(ctx({ res, token: ANTHROPIC_CRED }));

    expect(res.status).toBe(200);
    expect(streamSpy).toHaveBeenCalled();
  });
});

function oversizedCtx(res: ResponseStub, limit: number): GatewayHttpHandlerContext {
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  const req = {
    method: "POST",
    headers: { authorization: `Bearer ${ANTHROPIC_CRED}` },
    once: () => undefined,
    off: () => undefined,
    async *[Symbol.asyncIterator]() {
      for (let sent = 0; sent <= limit; sent += chunk.length) yield chunk;
    },
  };
  return { req, res, pathname: MESSAGES } as unknown as GatewayHttpHandlerContext;
}

describe("route surface", () => {
  it("applies a model override only through the injected reader", async () => {
    const previous = process.env.FLEET_AI_GATEWAY_MODEL;
    process.env.FLEET_AI_GATEWAY_MODEL = "claude-gateway--codex--gpt-5.6-luna";
    try {
      const settingsResponse = response();
      const settingsRouter = createAiGatewayRouter({
        gateway: stubGateway(),
        readAiGatewaySettings: aiGatewaySettingsStub({
          version: 1,
          models: [{ id: "codex--gpt-5.6-sol" }],
        }),
        readAuth,
      });
      await settingsRouter.handle(ctx({
        res: settingsResponse,
        token: ANTHROPIC_CRED,
        pathname: `${BASE}/v1/models`,
        method: "GET",
      }));

      const withoutReaderGateway = stubGateway();
      const withoutReaderSpy = vi.spyOn(withoutReaderGateway, "stream");
      const withoutReader = createAiGatewayRouter({
        gateway: withoutReaderGateway,
        readAuth,
      });
      await withoutReader.handle(ctx({
        res: response(),
        token: ANTHROPIC_CRED,
        model: "claude-gateway--codex--gpt-5.6-sol",
      }));

      const withReaderGateway = stubGateway();
      const withReaderSpy = vi.spyOn(withReaderGateway, "stream");
      const withReader = createAiGatewayRouter({
        gateway: withReaderGateway,
        readAuth,
        readModelOverride: () => process.env.FLEET_AI_GATEWAY_MODEL,
      });
      await withReader.handle(ctx({
        res: response(),
        token: ANTHROPIC_CRED,
        model: "claude-gateway--codex--gpt-5.6-sol",
      }));

      expect(JSON.parse(settingsResponse.body).data).toEqual([
        expect.objectContaining({ id: "claude-gateway--codex--gpt-5.6-sol" }),
      ]);
      expect(withoutReaderSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        model: "gpt-5.6-sol",
      }));
      expect(withReaderSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        model: "gpt-5.6-luna",
      }));
      settingsRouter.dispose();
      withoutReader.dispose();
      withReader.dispose();
    } finally {
      if (previous === undefined) delete process.env.FLEET_AI_GATEWAY_MODEL;
      else process.env.FLEET_AI_GATEWAY_MODEL = previous;
    }
  });

  it("answers the Claude Code connectivity probe", async () => {
    const router = createAiGatewayRouter({ gateway: stubGateway(), readAuth });
    const res = response();
    await router.handle(ctx({ res, pathname: `${BASE}/api/hello`, method: "HEAD" }));

    expect(res.status).toBe(200);
  });

  it("serves model discovery to an authorized caller", async () => {
    const router = createAiGatewayRouter({ gateway: stubGateway(), readAuth });
    const res = response();
    await router.handle(ctx({ res, token: ANTHROPIC_CRED, pathname: `${BASE}/v1/models`, method: "GET" }));

    expect(res.status).toBe(200);
    const list = JSON.parse(res.body) as { data: Array<{ id: string; display_name: string }> };
    const ids = list.data.map((entry) => entry.id);
    // picker가 버리지 않도록 모든 항목이 claude- alias로 나가야 한다.
    expect(ids.every((id) => id.startsWith("claude"))).toBe(true);
    expect(list.data).toHaveLength(54);
    // All Antigravity models carry a real 1M window, so they are advertised on
    // Claude Code's `[1m]` coordinate rather than its unmarked 200k one.
    expect(ids).toContain("claude-gateway--antigravity--gemini-3.8-flash[1m]");
    expect(ids).toContain("claude-gateway--antigravity--gemini-3.7-flash[1m]");
    expect(ids).toContain("claude-gateway--antigravity--gemini-3.1-pro[1m]");
    expect(ids).toContain("claude-gateway--codex--gpt-5.6-sol");
    expect(ids).toContain("claude-gateway--codex--gpt-5.6-sol-fast");
    expect(ids).toContain("claude-gateway--codex--gpt-5.6-luna");
    expect(ids).toContain("claude-gateway--codex--gpt-5.6-luna-fast");
    expect(ids).toContain("claude-gateway--codex--gpt-5.6-terra");
    expect(ids).toContain("claude-gateway--codex--gpt-5.6-terra-fast");
    expect(ids).toContain("claude-gateway--codex--gpt-5.6-sol-524k");
    expect(ids).toContain("claude-gateway--codex--gpt-5.6-sol-524k-fast");
    expect(ids).toContain("claude-gateway--codex--gpt-5.6-luna-524k");
    expect(ids).toContain("claude-gateway--codex--gpt-5.6-luna-524k-fast");
    expect(ids).toContain("claude-gateway--codex--gpt-5.6-terra-524k");
    expect(ids).toContain("claude-gateway--codex--gpt-5.6-terra-524k-fast");
    expect(ids).toContain("claude-gateway--codex--gpt-5.6-sol-1m[1m]");
    expect(ids).toContain("claude-gateway--codex--gpt-5.6-sol-1m-fast[1m]");
    expect(ids).toContain("claude-gateway--codex--gpt-5.6-luna-1m[1m]");
    expect(ids).toContain("claude-gateway--codex--gpt-5.6-luna-1m-fast[1m]");
    expect(ids).toContain("claude-gateway--codex--gpt-5.6-terra-1m[1m]");
    expect(ids).toContain("claude-gateway--codex--gpt-5.6-terra-1m-fast[1m]");
    expect(ids).not.toContain("claude-gateway--codex--gpt-5.6-sol-524k[524k]");
    expect(ids).not.toContain("claude-gateway--codex--gpt-5.6-sol[1m]");
    expect(ids).not.toContain("claude-gateway--codex--gpt-5.6-sol-1m[1m][1m]");
    expect(ids).toContain("claude-gateway--cursor--auto");
    expect(ids).toContain("claude-gateway--cursor--composer-2.5");
    expect(ids).toContain("claude-gateway--cursor--composer-2.5-fast");
    expect(ids).toContain("claude-gateway--cursor--grok-4.5");
    expect(ids).toContain("claude-gateway--cursor--grok-4.5-fast");
    expect(ids).toContain("claude-gateway--cursor--grok-4.6");
    expect(ids).toContain("claude-gateway--cursor--grok-4.6-fast");
    expect(ids).not.toContain("claude-gateway--cursor--gpt-5.6-sol[1m]");
    expect(ids).toContain("claude-gateway--cursor--claude-opus-5");
    expect(ids).toContain("claude-gateway--cursor--claude-opus-5-1m[1m]");
    expect(ids).toContain("claude-gateway--cursor--claude-fable-5");
    expect(ids).toContain("claude-gateway--cursor--claude-fable-5-1m[1m]");
    expect(ids).toContain("claude-gateway--cursor--gpt-5.6-sol");
    expect(ids).toContain("claude-gateway--cursor--gpt-5.6-terra");
    expect(ids).toContain("claude-gateway--cursor--gpt-5.6-luna");
    expect(ids).toContain("claude-gateway--cursor--gemini-3.7-flash");
    expect(ids).toContain("claude-gateway--cursor--kimi-k3");
    expect(ids).not.toContain("claude-gateway--cursor--kimi-k3[1m]");
    expect(ids).toContain("claude-gateway--kimi--k3[1m]");
    expect(ids).toContain("claude-gateway--kimi--k3-256k");
    expect(ids).toContain("claude-gateway--opencode--minimax-m3[1m]");
    expect(ids).toContain("claude-gateway--opencode--ox-alpha-free[1m]");
    expect(ids).toContain("claude-gateway--opencode--muse-spark-1.2-contributor[1m]");
    expect(list.data).toContainEqual(expect.objectContaining({
      id: "claude-gateway--cursor--grok-4.5",
      display_name: "Cursor-Grok-4.5",
    }));
    expect(list.data).toContainEqual(expect.objectContaining({
      id: "claude-gateway--kimi--k3[1m]",
      display_name: "Moonshot-Kimi-K3-1M (1M Context)",
    }));
    expect(list.data).toContainEqual(expect.objectContaining({
      id: "claude-gateway--xai--grok-4.6",
      display_name: "xAI-Grok-4.6",
    }));
    expect(list.data).toContainEqual(expect.objectContaining({
      id: "claude-gateway--xai--grok-composer-2.5-fast",
      display_name: "xAI-Grok-Composer-2.5-Fast",
    }));
    expect(list.data.every((entry) => /^(Antigravity|Codex|Cursor|Moonshot-Kimi|OpenCode|xAI)-/.test(entry.display_name))).toBe(true);
  });

  it("filters model discovery to the curated allowlist", async () => {
    const router = createAiGatewayRouter({
      gateway: stubGateway(),
      readAuth,
      readAiGatewaySettings: aiGatewaySettingsStub({
        version: 1,
        models: [
          { id: "cursor--grok-4.5" },
          // Cursor composer와 Kimi 프로바이더는 별개 경로 — 동시 노출을 보존한다.
          { id: "cursor--composer-2.5" },
          { id: "kimi--k3-256k" },
          { id: "kimi--no-longer-in-catalog" },
        ],
      }),
    });
    const res = response();
    await router.handle(ctx({ res, token: ANTHROPIC_CRED, pathname: `${BASE}/v1/models`, method: "GET" }));

    expect(res.status).toBe(200);
    const list = JSON.parse(res.body) as { data: Array<{ id: string }> };
    expect(list.data.map((entry) => entry.id)).toEqual([
      "claude-gateway--cursor--composer-2.5",
      "claude-gateway--cursor--grok-4.5",
      "claude-gateway--kimi--k3-256k",
    ]);
  });

  it("sorts an interleaved allowlist into provider clusters for /v1/models", async () => {
    const router = createAiGatewayRouter({
      gateway: stubGateway(),
      readAuth,
      readAiGatewaySettings: aiGatewaySettingsStub({
        version: 1,
        models: [
          { id: "kimi--k3" },
          { id: "codex--gpt-5.6-luna-fast" },
          { id: "cursor--grok-4.5-fast" },
          { id: "codex--gpt-5.6-sol-fast" },
        ],
      }),
    });
    const res = response();
    await router.handle(ctx({ res, token: ANTHROPIC_CRED, pathname: `${BASE}/v1/models`, method: "GET" }));

    expect(res.status).toBe(200);
    const list = JSON.parse(res.body) as { data: Array<{ id: string }> };
    expect(list.data.map((entry) => entry.id)).toEqual([
      "claude-gateway--codex--gpt-5.6-sol-fast",
      "claude-gateway--codex--gpt-5.6-luna-fast",
      "claude-gateway--cursor--grok-4.5-fast",
      "claude-gateway--kimi--k3[1m]",
    ]);
  });

  it("exposes no gateway models until the settings enable some (opt-in)", async () => {
    const router = createAiGatewayRouter({
      gateway: stubGateway(),
      readAuth,
      readAiGatewaySettings: aiGatewaySettingsStub({ version: 1 }),
    });
    const res = response();
    await router.handle(ctx({ res, token: ANTHROPIC_CRED, pathname: `${BASE}/v1/models`, method: "GET" }));

    expect(res.status).toBe(200);
    const list = JSON.parse(res.body) as { data: Array<{ id: string }> };
    // 게이트웨이 세션은 Claude Code 내장 모델만 보게 된다.
    expect(list.data).toHaveLength(0);
  });

  it("refuses model discovery without a bearer", async () => {
    const router = createAiGatewayRouter({ gateway: stubGateway(), readAuth });
    const res = response();
    await router.handle(ctx({ res, pathname: `${BASE}/v1/models`, method: "GET" }));

    expect(res.status).toBe(401);
  });

  it("declines unknown sub-paths so the host can 404 them", async () => {
    const router = createAiGatewayRouter({ gateway: stubGateway(), readAuth });
    const handled = await router.handle(ctx({ res: response(), pathname: `${BASE}/v1/embeddings` }));

    expect(handled).toBe(false);
  });

  it("rejects a non-POST call to the messages endpoint", async () => {
    const router = createAiGatewayRouter({ gateway: stubGateway(), readAuth });
    const res = response();
    await router.handle(ctx({ res, method: "GET" }));

    expect(res.status).toBe(405);
  });

  it("rejects an unknown id reserved for the gateway instead of leaking it to Anthropic", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const router = createAiGatewayRouter({ fetch: fetchMock, readAuth });
    const res = response();
    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--cursor--does-not-exist",
    }));

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("usage-limit directive", () => {
  /** Claude Code injects this behind the tool results of the turn it interrupts. */
  const DIRECTIVE = "[Usage limit approaching. Checkpoint now: finish the current step, then list up to 3 short bullets of the most impactful remaining work. Don't start subagents or long-running work.]";
  const CONVERSATION = [
    { role: "user", content: "Fix the composer width." },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    { role: "user", content: [{ type: "text", text: DIRECTIVE }] },
  ];

  it("never reaches a translated provider", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      "event: message_stop\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const router = createAiGatewayRouter({
      fetch: fetchMock,
      readAuth,
      readOpencodeApiKey: async () => "opencode-secret",
    });

    await router.handle(ctx({
      res: response(),
      token: ANTHROPIC_CRED,
      model: "claude-gateway--opencode--minimax-m3[1m]",
      messages: CONVERSATION,
    }));

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      readonly messages: ReadonlyArray<{ readonly role: string }>;
    };
    expect(JSON.stringify(body.messages)).not.toContain("Usage limit");
    // The turn the directive interrupted still ends the request.
    expect(body.messages).toHaveLength(3);
    expect(body.messages[body.messages.length - 1]?.role).toBe("user");
  });

  it("is stripped from native Anthropic passthrough too", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      "event: message_stop\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const router = createAiGatewayRouter({ fetch: fetchMock, readAuth });

    await router.handle(ctx({
      res: response(),
      token: ANTHROPIC_CRED,
      model: "claude-sonnet-4-6",
      messages: CONVERSATION,
    }));

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      readonly messages: ReadonlyArray<unknown>;
    };
    expect(JSON.stringify(body.messages)).not.toContain("Usage limit");
    expect(body.messages).toHaveLength(3);
  });
});

function createAiGatewayRouter(
  deps: Partial<AiGatewayRouteDeps> = {},
) {
  // readAuth/readCursorToken은 프로덕션에서 필수 주입이다. 테스트 래퍼는 자격증명 부재 스텁을
  // 기본값으로 두고, 각 테스트가 필요한 조달자만 덮어쓴다.
  return createCoreAiGatewayRouter({
    originator: "fleet-console",
    readAuth: () => null,
    readCursorToken: () => null,
    ...deps,
  });
}

function readAuth() {
  return { accessToken: SUBSCRIPTION_TOKEN, accountId: ACCOUNT_ID };
}

function stubGateway(onRequest?: (request: CanonicalResponseRequest) => void): AnthropicMessagesGateway {
  const adapter: AiGatewayAdapter = {
    async stream(request): Promise<AdapterResponse> {
      onRequest?.(request);
      return successfulAdapterResponse();
    },
  };
  return new AnthropicMessagesGateway(adapter);
}

function successfulAdapterResponse(): AdapterResponse {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    events: (async function* () {
      yield {
        type: "response.created",
        response: { id: "resp_stub", model: "gpt-5.5", usage: null },
      } as const;
      yield {
        type: "response.completed",
        response: {
          id: "resp_stub",
          model: "gpt-5.5",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      } as const;
    })(),
  };
}

interface ResponseStub {
  status: number;
  headers: Record<string, string>;
  body: string;
  headersSent: boolean;
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: Uint8Array | string): boolean;
  end(body?: string): void;
  once(event: string, listener: () => void): void;
}

function response(): ResponseStub {
  const decoder = new TextDecoder();
  return {
    status: 0,
    headers: {},
    body: "",
    headersSent: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    write(chunk) {
      this.body += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      return true;
    },
    end(body) {
      if (body !== undefined) this.body += body;
    },
    once() {
      /* backpressure is never exercised by the stub writer */
    },
  };
}

function ctx(options: {
  readonly res: ResponseStub;
  readonly token?: string;
  readonly pathname?: string;
  readonly method?: string;
  readonly model?: string;
  readonly apiKey?: string;
  readonly thinking?: Record<string, unknown>;
  readonly outputConfig?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown> | null;
  readonly messages?: ReadonlyArray<Record<string, unknown>>;
  readonly tools?: ReadonlyArray<Record<string, unknown>>;
  readonly toolChoice?: Record<string, unknown>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly rawBody?: unknown;
}): GatewayHttpHandlerContext {
  const payload = JSON.stringify(options.rawBody ?? {
    model: options.model ?? "claude-gateway--codex--gpt-5.6-sol",
    messages: options.messages ?? [{ role: "user", content: "Hello" }],
    max_tokens: 128,
    ...(options.thinking ? { thinking: options.thinking } : {}),
    ...(options.outputConfig ? { output_config: options.outputConfig } : {}),
    ...(options.metadata === null
      ? {}
      : { metadata: options.metadata ?? { user_id: "claude-session-test" } }),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
    stream: true,
  });
  const req = {
    method: options.method ?? "POST",
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(options.apiKey === undefined ? {} : { "x-api-key": options.apiKey }),
      ...options.headers,
    },
    once: () => undefined,
    off: () => undefined,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(payload);
    },
  };
  return {
    req,
    res: options.res,
    pathname: options.pathname ?? MESSAGES,
  } as unknown as GatewayHttpHandlerContext;
}
