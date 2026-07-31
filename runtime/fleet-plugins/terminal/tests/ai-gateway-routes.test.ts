import { AnthropicMessagesGateway } from "@dotobokuri/core-ai-gateway";
import type { AdapterResponse, AiGatewayAdapter } from "@dotobokuri/core-ai-gateway";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { RouteHandler, RouteHandlerContext } from "@fleet-console/sdk/routing";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AI_GATEWAY_AUTH_PROVIDER_ID,
  AI_GATEWAY_EXPERIMENTAL_ENV,
  UPSTREAM_KEY_ENV,
  createAiGatewayRouter,
  registerAiGatewayRoutes,
} from "../server/ai-gateway-routes.js";

const BASE = "/plugins/terminal/ai-gateway";
const MESSAGES = `${BASE}/v1/messages`;
const STORED_KEY = "sk-upstream-secret";

afterEach(() => {
  delete process.env[AI_GATEWAY_EXPERIMENTAL_ENV];
});

describe("experimental seal", () => {
  it("does not register any route while the seal is closed", () => {
    const registerRouter = vi.fn();
    const routes = registerAiGatewayRoutes(pluginCtx(registerRouter), { authService: authService() });

    expect(routes.enabled).toBe(false);
    expect(registerRouter).not.toHaveBeenCalled();
    expect(() => routes.issueToken()).toThrow(/disabled/);
  });

  it("registers the route once the seal is opened", () => {
    process.env[AI_GATEWAY_EXPERIMENTAL_ENV] = "1";
    const registerRouter = vi.fn();
    const routes = registerAiGatewayRoutes(pluginCtx(registerRouter), { authService: authService() });

    expect(routes.enabled).toBe(true);
    expect(registerRouter).toHaveBeenCalledTimes(1);
    expect(registerRouter.mock.calls[0]?.[0]).toBe("ai-gateway");
  });
});

describe("gateway token", () => {
  it("rejects a request that carries no bearer", async () => {
    const router = createAiGatewayRouter({ authService: authService(), gateway: stubGateway() });
    const res = response();
    await router.handle(ctx({ res }));

    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      type: "error",
      error: { type: "authentication_error", message: "Invalid gateway token" },
    });
  });

  it("rejects a bearer that was never issued", async () => {
    const router = createAiGatewayRouter({ authService: authService(), gateway: stubGateway() });
    const res = response();
    await router.handle(ctx({ res, token: "f".repeat(64) }));

    expect(res.status).toBe(401);
  });

  it("accepts an issued bearer and streams the upstream body through", async () => {
    const router = createAiGatewayRouter({ authService: authService(), gateway: stubGateway() });
    const grant = router.issueToken();
    const res = response();
    await router.handle(ctx({ res, token: grant.token }));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("message_stop");
  });

  it("stops accepting a revoked bearer", async () => {
    const router = createAiGatewayRouter({ authService: authService(), gateway: stubGateway() });
    const grant = router.issueToken();
    grant.revoke();
    const res = response();
    await router.handle(ctx({ res, token: grant.token }));

    expect(res.status).toBe(401);
  });

  it("keeps one operation's bearer from being replaced by another's", async () => {
    const router = createAiGatewayRouter({ authService: authService(), gateway: stubGateway() });
    const first = router.issueToken();
    const second = router.issueToken();
    second.revoke();

    const res = response();
    await router.handle(ctx({ res, token: first.token }));
    expect(res.status).toBe(200);
  });
});

describe("upstream credential", () => {
  it("refuses to call upstream when no credential is stored, without leaking the provider id", async () => {
    delete process.env[UPSTREAM_KEY_ENV];
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const router = createAiGatewayRouter({ authService: authService(null), gateway });
    const grant = router.issueToken();
    const res = response();
    await router.handle(ctx({ res, token: grant.token }));

    expect(res.status).toBe(401);
    expect(streamSpy).not.toHaveBeenCalled();
    expect(res.body).not.toContain(AI_GATEWAY_AUTH_PROVIDER_ID);
  });

  it("never echoes the stored upstream key back to the caller", async () => {
    const router = createAiGatewayRouter({ authService: authService(), gateway: stubGateway() });
    const grant = router.issueToken();
    const res = response();
    await router.handle(ctx({ res, token: grant.token }));

    expect(`${JSON.stringify(res.headers)}${res.body}`).not.toContain(STORED_KEY);
  });
});

describe("route surface", () => {
  it("answers the Claude Code connectivity probe", async () => {
    const router = createAiGatewayRouter({ authService: authService(), gateway: stubGateway() });
    const res = response();
    await router.handle(ctx({ res, pathname: `${BASE}/api/hello`, method: "HEAD" }));

    expect(res.status).toBe(200);
  });

  it("declines unknown sub-paths so the host can 404 them", async () => {
    const router = createAiGatewayRouter({ authService: authService(), gateway: stubGateway() });
    const handled = await router.handle(ctx({ res: response(), pathname: `${BASE}/v1/models` }));

    expect(handled).toBe(false);
  });

  it("rejects a non-POST call to the messages endpoint", async () => {
    const router = createAiGatewayRouter({ authService: authService(), gateway: stubGateway() });
    const res = response();
    await router.handle(ctx({ res, method: "GET" }));

    expect(res.status).toBe(405);
  });
});

// null은 "저장된 자격증명 없음"을 뜻한다. undefined를 쓰면 기본 매개변수가 되살아나 케이스가 사라진다.
function authService(key: string | null = STORED_KEY) {
  return { getApiKey: async () => key ?? undefined };
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
}): RouteHandlerContext {
  const payload = JSON.stringify({
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "Hello" }],
    max_tokens: 128,
    stream: true,
  });
  const req = {
    method: options.method ?? "POST",
    headers: options.token === undefined ? {} : { authorization: `Bearer ${options.token}` },
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
