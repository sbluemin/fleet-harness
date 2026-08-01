import { AnthropicMessagesGateway } from "@dotobokuri/core-ai-gateway";
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
      model: "claude-gateway--codex--gpt-5.6-sol-fast",
    }));

    expect(streamSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      apiKey: SUBSCRIPTION_TOKEN,
      contextWindow: 372_000,
      model: "gpt-5.6-sol",
      serviceTier: "priority",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    }));
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

  it("rejects a Cursor effort when the model has no supported lower rung", async () => {
    const router = createAiGatewayRouter({
      readAuth,
      readCursorToken: () => "cursor-subscription-token",
    });
    const res = response();

    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--cursor--glm-5.2[1m]",
      thinking: { type: "adaptive" },
      outputConfig: { effort: "medium" },
    }));

    expect(res.status).toBe(400);
    expect(res.body).toContain("no supported reasoning effort at or below");
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
      model: "claude-gateway--k3[1m]",
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
    expect(list.data).toHaveLength(23);
    expect(ids).toContain("claude-gateway--codex--gpt-5.6-sol-fast[1m]");
    expect(ids).toContain("claude-gateway--cursor--auto");
    expect(ids).toContain("claude-gateway--kimi--k3[1m]");
    expect(list.data.every((entry) => /^(Codex|Cursor|Kimi)-/.test(entry.display_name))).toBe(true);
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
    },
  };
  return new AnthropicMessagesGateway(adapter);
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
}): RouteHandlerContext {
  const payload = JSON.stringify({
    model: options.model ?? "claude-gateway--codex--gpt-5.6-sol",
    messages: [{ role: "user", content: "Hello" }],
    max_tokens: 128,
    ...(options.thinking ? { thinking: options.thinking } : {}),
    ...(options.outputConfig ? { output_config: options.outputConfig } : {}),
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
