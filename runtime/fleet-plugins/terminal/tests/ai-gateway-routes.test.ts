import {
  AnthropicMessagesGateway,
  CURSOR_EXTERNAL_ROOT_BYTE_LIMIT,
  ContextWindowExceededError,
  CursorAdapter,
} from "@dotobokuri/core-ai-gateway";
import type {
  AdapterResponse,
  AiGatewayAdapter,
  CanonicalResponseRequest,
} from "@dotobokuri/core-ai-gateway";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { RouteHandler, RouteHandlerContext } from "@fleet-console/sdk/routing";
import { describe, expect, it, vi } from "vitest";

import {
  KIMI_MESSAGES_URL,
  createAiGatewayRouter,
  registerAiGatewayRoutes,
} from "../server/ai-gateway-routes.js";
import type { AiGatewayStoredSettings } from "../server/ai-gateway-settings.js";

function aiGatewaySettingsStub(settings: AiGatewayStoredSettings): () => Promise<AiGatewayStoredSettings> {
  return () => Promise.resolve(settings);
}

const BASE = "/plugins/terminal/ai-gateway";
const MESSAGES = `${BASE}/v1/messages`;
const ANTHROPIC_CRED = "sk-ant-oat01-caller";
const SUBSCRIPTION_TOKEN = "chatgpt-subscription-access-token";
const ACCOUNT_ID = "11111111-2222-3333-4444-555555555555";

describe("route registration", () => {
  it("always registers the AI gateway route", () => {
    const registerRouter = vi.fn();
    registerAiGatewayRoutes(pluginCtx(registerRouter));

    expect(registerRouter).toHaveBeenCalledTimes(1);
    expect(registerRouter.mock.calls[0]?.[0]).toBe("ai-gateway");
  });

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
          model: "claude-gateway--cursor--kimi-k3",
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
      model: "claude-gateway--codex--gpt-5.6-sol-fast[1m]",
    }));

    expect(streamSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      apiKey: SUBSCRIPTION_TOKEN,
      contextWindow: 272_000,
      model: "gpt-5.6-sol",
      serviceTier: "priority",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    }));
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
      model: "claude-gateway--codex--gpt-5.6-luna[1m]",
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
      model: "claude-gateway--cursor--kimi-k3",
      thinking: { type: "adaptive" },
      outputConfig: { effort: "medium" },
    }));

    expect(canonical?.model).toBe("kimi-k3");
    expect(canonical?.reasoning).toEqual({ summary: "auto", effort: "medium" });
    expect(streamSpy.mock.calls[0]?.[1]).not.toHaveProperty("reasoningEfforts");
  });

  it.each([
    [{ version: 1 } satisfies AiGatewayStoredSettings, false],
    [{ version: 1, cursorDiagnosticsEnabled: true } satisfies AiGatewayStoredSettings, true],
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
      readAiGatewaySettings: async () => { throw new Error("settings unavailable"); },
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
      model: "claude-gateway--cursor--kimi-k3-1m[1m]",
      metadata: null,
    }));

    expect(res.status).toBe(400);
    expect(res.body).toContain("metadata.user_id");
  });

  it("returns Claude's prompt-too-long contract for unreplayable Cursor input", async () => {
    const router = createAiGatewayRouter({
      readAuth,
      readCursorToken: () => "cursor-subscription-token",
    });
    const res = response();

    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--cursor--grok-4.5-fast",
      messages: [{
        role: "user",
        content: "x".repeat(CURSOR_EXTERNAL_ROOT_BYTE_LIMIT),
      }],
    }));

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: expect.stringMatching(/^Prompt is too long:/),
      },
    });
  });
});

describe("model context window", () => {
  it.each([
    // The guard and the projection both take the model's real window, so a marked
    // model's occupancy can never be reported above the 1M coordinate.
    ["claude-gateway--codex--gpt-5.6-sol", 272_000, 272_000],
    ["claude-gateway--cursor--grok-4.5-fast", 256_000, 256_000],
    // A 200000-window Cursor native model earns no `[1m]` marker, so it gets no
    // projection denominator — but the guard still needs its real window.
    ["claude-gateway--cursor--kimi-k3", 200_000, undefined],
  ])("passes %s's real window as modelContextWindow", async (model, expected, projected) => {
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const router = createAiGatewayRouter({
      gateway,
      readAuth,
      readCursorToken: () => "cursor-subscription-token",
    });

    await router.handle(ctx({ res: response(), token: ANTHROPIC_CRED, model }));

    expect(streamSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      modelContextWindow: expected,
    }));
    const options = streamSpy.mock.calls[0]?.[1];
    if (projected === undefined) {
      expect(options).not.toHaveProperty("contextWindow");
    } else {
      expect(options).toHaveProperty("contextWindow", projected);
    }
  });

  it("answers a pre-flight overflow with Claude's prompt-too-long contract", async () => {
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const router = createAiGatewayRouter({ gateway, readAuth });
    const res = response();

    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--codex--gpt-5.6-sol",
      // 4 chars/token puts this at ~500_000 tokens against a 272_000 window.
      messages: [{ role: "user", content: "x".repeat(2_000_000) }],
    }));

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: expect.stringMatching(/^Prompt is too long: \d+ tokens > 272000 maximum$/),
      },
    });
    // The guard runs inside the gateway, so upstream was still spared the turn.
    expect(streamSpy).toHaveBeenCalledTimes(1);
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
        message: "Prompt is too long: 300000 tokens > 272000 maximum",
      },
    });
  });
});

describe("Kimi passthrough", () => {
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
          name: "mcp__fleet__carrier_dispatch",
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
            tool_name: "mcp__fleet__carrier_dispatch",
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
      content: [{ type: "text", text: "Tool available: mcp__fleet__carrier_dispatch" }],
    });
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

  it("passes sub-1M cache-aware SSE usage through without projection", async () => {
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
          input_tokens: 32_768,
          cache_read_input_tokens: 32_768,
          cache_creation_input_tokens: 0,
          output_tokens: 2,
        },
      },
    });
  });
});

describe("anthropic passthrough", () => {
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
});

describe("route surface", () => {
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
    expect(list.data).toHaveLength(17);
    expect(ids).toContain("claude-gateway--codex--gpt-5.6-sol-fast[1m]");
    expect(ids).toContain("claude-gateway--cursor--auto[1m]");
    expect(ids).toContain("claude-gateway--cursor--kimi-k3");
    expect(ids).toContain("claude-gateway--cursor--kimi-k3-1m[1m]");
    expect(ids).toContain("claude-gateway--kimi--k3[1m]");
    expect(ids).toContain("claude-gateway--kimi--k3-256k");
    expect(ids.some((id) => id.includes("--codex--") && id.endsWith("[1m]"))).toBe(true);
    expect(list.data).toContainEqual(expect.objectContaining({
      id: "claude-gateway--cursor--kimi-k3-1m[1m]",
      display_name: "Cursor-Kimi-K3-1M (1M Context)",
    }));
    expect(list.data).toContainEqual(expect.objectContaining({
      id: "claude-gateway--kimi--k3[1m]",
      display_name: "Moonshot-Kimi-K3-1M (1M Context)",
    }));
    expect(list.data.every((entry) => /^(Codex|Cursor|Moonshot-Kimi)-/.test(entry.display_name))).toBe(true);
  });

  it("filters model discovery to the curated allowlist", async () => {
    const router = createAiGatewayRouter({
      gateway: stubGateway(),
      readAuth,
      readAiGatewaySettings: aiGatewaySettingsStub({
        version: 1,
        models: [
          { id: "cursor--claude-opus-5" },
          // Cursor 경유 Kimi와 Kimi 프로바이더는 별개 경로 — 동시 노출을 보존한다.
          { id: "cursor--kimi-k3-1m" },
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
      "claude-gateway--cursor--claude-opus-5[1m]",
      "claude-gateway--cursor--kimi-k3-1m[1m]",
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
      "claude-gateway--codex--gpt-5.6-sol-fast[1m]",
      "claude-gateway--codex--gpt-5.6-luna-fast[1m]",
      "claude-gateway--cursor--grok-4.5-fast[1m]",
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

function readAuth() {
  return { accessToken: SUBSCRIPTION_TOKEN, accountId: ACCOUNT_ID };
}

function pluginCtx(registerRouter: (path: string, handler: RouteHandler) => void): FleetPluginServerContext {
  return {
    pluginId: "terminal",
    basePath: "/plugins/terminal",
    registerRouter,
    host: {
      paths: { pluginDataDir: () => "/tmp/fleet-console-test/plugins/terminal" },
      lifecycle: { registerCleanup: () => () => undefined },
    },
  } as unknown as FleetPluginServerContext;
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
}): RouteHandlerContext {
  const payload = JSON.stringify({
    model: options.model ?? "claude-gateway--codex--gpt-5.6-sol",
    messages: options.messages ?? [{ role: "user", content: "Hello" }],
    max_tokens: 128,
    ...(options.thinking ? { thinking: options.thinking } : {}),
    ...(options.outputConfig ? { output_config: options.outputConfig } : {}),
    ...(options.metadata === null
      ? {}
      : { metadata: options.metadata ?? { user_id: "claude-session-test" } }),
    ...(options.tools ? { tools: options.tools } : {}),
    stream: true,
  });
  const req = {
    method: options.method ?? "POST",
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(options.apiKey === undefined ? {} : { "x-api-key": options.apiKey }),
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
  } as unknown as RouteHandlerContext;
}
