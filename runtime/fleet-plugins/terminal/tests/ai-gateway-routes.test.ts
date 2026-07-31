import { AnthropicMessagesGateway } from "@dotobokuri/core-ai-gateway";
import type { AdapterResponse, AiGatewayAdapter } from "@dotobokuri/core-ai-gateway";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { RouteHandler, RouteHandlerContext } from "@fleet-console/sdk/routing";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AI_GATEWAY_EXPERIMENTAL_ENV,
  createAiGatewayRouter,
  registerAiGatewayRoutes,
} from "../server/ai-gateway-routes.js";

const BASE = "/plugins/terminal/ai-gateway";
const MESSAGES = `${BASE}/v1/messages`;
const ANTHROPIC_CRED = "sk-ant-oat01-caller";
const SUBSCRIPTION_TOKEN = "chatgpt-subscription-access-token";
const ACCOUNT_ID = "11111111-2222-3333-4444-555555555555";

afterEach(() => {
  delete process.env[AI_GATEWAY_EXPERIMENTAL_ENV];
});

describe("experimental seal", () => {
  it("does not register any route while the seal is closed", () => {
    const registerRouter = vi.fn();
    const routes = registerAiGatewayRoutes(pluginCtx(registerRouter));

    expect(routes.enabled).toBe(false);
    expect(registerRouter).not.toHaveBeenCalled();
    expect(() => routes.issueToken()).toThrow(/disabled/);
  });

  it("registers the route once the seal is opened", () => {
    process.env[AI_GATEWAY_EXPERIMENTAL_ENV] = "1";
    const registerRouter = vi.fn();
    const routes = registerAiGatewayRoutes(pluginCtx(registerRouter));

    expect(routes.enabled).toBe(true);
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

  it("never issues a gateway bearer of its own", () => {
    const router = createAiGatewayRouter({ gateway: stubGateway(), readAuth });
    // Claude Code가 자기 OAuth를 계속 쓰도록 자체 토큰을 주입하지 않는다.
    expect(router.issueToken().token).toBe("");
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
    const list = JSON.parse(res.body) as { data: Array<{ id: string }> };
    const ids = list.data.map((entry) => entry.id);
    // picker가 버리지 않도록 모든 항목이 claude- alias로 나가야 한다.
    expect(ids.every((id) => id.startsWith("claude"))).toBe(true);
    expect(ids).toContain("claude-gateway--gpt-5.5");
    expect(ids).toContain("claude-gateway--cursor-auto");
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
});

function readAuth() {
  return { accessToken: SUBSCRIPTION_TOKEN, accountId: ACCOUNT_ID };
}

function pluginCtx(registerRouter: (path: string, handler: RouteHandler) => void): FleetPluginServerContext {
  return { pluginId: "terminal", basePath: "/plugins/terminal", registerRouter } as unknown as FleetPluginServerContext;
}

function stubGateway(): AnthropicMessagesGateway {
  const adapter: AiGatewayAdapter = {
    async stream(): Promise<AdapterResponse> {
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
}): RouteHandlerContext {
  const payload = JSON.stringify({
    model: options.model ?? "claude-gateway--gpt-5.5",
    messages: [{ role: "user", content: "Hello" }],
    max_tokens: 128,
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
