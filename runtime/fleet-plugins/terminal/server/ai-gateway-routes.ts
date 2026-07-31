import { randomBytes, timingSafeEqual } from "node:crypto";

import { AnthropicMessagesGateway } from "@dotobokuri/core-ai-gateway";
import type { AnthropicMessagesRequest } from "@dotobokuri/core-ai-gateway";
import type { AuthService } from "@dotobokuri/core-infra";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { registerRouter } from "@fleet-console/sdk/plugin/node";
import type { RouteHandler } from "@fleet-console/sdk/routing";

export const AI_GATEWAY_ROUTE_SEGMENT = "ai-gateway";
export const AI_GATEWAY_AUTH_PROVIDER_ID = "AI Gateway with OpenAI";
export const AI_GATEWAY_EXPERIMENTAL_ENV = "FLEET_EXPERIMENTAL_AI_GATEWAY";
export const AI_GATEWAY_MODEL_ENV = "FLEET_AI_GATEWAY_MODEL";

const TOKEN_BYTES = 32;

export interface AiGatewayTokenGrant {
  readonly token: string;
  readonly revoke: () => void;
}

export interface AiGatewayTokenIssuer {
  /** Launch마다 1회용 bearer를 발급한다. Operation이 끝나면 revoke를 호출한다. */
  issueToken(): AiGatewayTokenGrant;
}

export interface AiGatewayRoutes extends AiGatewayTokenIssuer {
  /** Experimental 봉인이 열려 라우트가 실제로 등록되었는지. */
  readonly enabled: boolean;
}

export interface AiGatewayRouteDeps {
  readonly authService: Pick<AuthService, "getApiKey">;
  /** 테스트가 upstream을 대체할 수 있도록 주입 가능하게 둔다. */
  readonly gateway?: AnthropicMessagesGateway;
}

export interface AiGatewayRouter extends AiGatewayTokenIssuer {
  readonly handle: RouteHandler;
}

export function isAiGatewayEnabled(): boolean {
  return process.env[AI_GATEWAY_EXPERIMENTAL_ENV] === "1";
}

export function createAiGatewayRouter(deps: AiGatewayRouteDeps): AiGatewayRouter {
  const tokens = new Set<string>();
  const gateway = deps.gateway ?? new AnthropicMessagesGateway();

  const handle: RouteHandler = async ({ req, res, pathname }) => {
    // Claude Code는 base URL 뒤에 자기 경로를 붙인다. 연결 프로브는 /api/hello다.
    if (pathname.endsWith("/api/hello")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return true;
    }
    if (!pathname.endsWith("/v1/messages")) return false;
    if (req.method !== "POST") {
      writeAnthropicError(res, 405, "invalid_request_error", "Method not allowed");
      return true;
    }
    if (!authorize(req.headers.authorization, tokens)) {
      writeAnthropicError(res, 401, "authentication_error", "Invalid gateway token");
      return true;
    }

    const apiKey = await deps.authService.getApiKey(AI_GATEWAY_AUTH_PROVIDER_ID);
    if (!apiKey) {
      writeAnthropicError(res, 401, "authentication_error", "No upstream credential is configured");
      return true;
    }

    let body: AnthropicMessagesRequest | null;
    try {
      body = await readJsonBody<AnthropicMessagesRequest>(req);
    } catch {
      writeAnthropicError(res, 400, "invalid_request_error", "Request body was not valid JSON");
      return true;
    }
    if (!body || typeof body !== "object") {
      writeAnthropicError(res, 400, "invalid_request_error", "Request body must be a JSON object");
      return true;
    }

    const controller = new AbortController();
    const abort = (): void => controller.abort(new Error("client disconnected"));
    req.once("close", abort);

    try {
      const model = process.env[AI_GATEWAY_MODEL_ENV];
      const upstream = await gateway.stream(body, {
        apiKey,
        signal: controller.signal,
        ...(model ? { model } : {}),
      });
      res.writeHead(upstream.status, headerEntries(upstream.headers));
      for await (const chunk of upstream.body) {
        if (!res.write(chunk)) await drain(res);
      }
      res.end();
    } catch (error) {
      // 헤더를 이미 보낸 뒤의 실패는 스트림을 끊는 것 말고 알릴 방법이 없다.
      if (res.headersSent) {
        res.end();
      } else {
        writeAnthropicError(res, 502, "api_error", errorMessage(error));
      }
    } finally {
      req.off("close", abort);
    }
    return true;
  };

  return {
    handle,
    issueToken(): AiGatewayTokenGrant {
      const token = randomBytes(TOKEN_BYTES).toString("hex");
      tokens.add(token);
      return { token, revoke: () => void tokens.delete(token) };
    },
  };
}

export function registerAiGatewayRoutes(
  ctx: FleetPluginServerContext,
  deps: AiGatewayRouteDeps,
): AiGatewayRoutes {
  // Fail-closed: 봉인이 닫혀 있으면 라우트를 등록하지 않아 404로 떨어진다.
  if (!isAiGatewayEnabled()) {
    return { enabled: false, issueToken: rejectIssue };
  }
  const router = createAiGatewayRouter(deps);
  registerRouter(ctx, AI_GATEWAY_ROUTE_SEGMENT, router.handle);
  return { enabled: true, issueToken: router.issueToken };
}

function rejectIssue(): never {
  throw new Error("The experimental AI gateway is disabled.");
}

function authorize(header: string | undefined, tokens: ReadonlySet<string>): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice("Bearer ".length));
  let matched = false;
  // Loopback은 인가가 아니다. 등록된 토큰 전체를 constant-time으로 대조한다.
  for (const token of tokens) {
    const candidate = Buffer.from(token);
    if (candidate.length === presented.length && timingSafeEqual(candidate, presented)) {
      matched = true;
    }
  }
  return matched;
}

async function readJsonBody<T>(req: {
  [Symbol.asyncIterator](): AsyncIterator<Buffer | string>;
}): Promise<T | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function headerEntries(headers: Headers): Record<string, string> {
  const entries: Record<string, string> = {};
  headers.forEach((value, key) => {
    entries[key] = value;
  });
  return entries;
}

async function drain(res: { once(event: "drain", listener: () => void): unknown }): Promise<void> {
  await new Promise<void>((resolve) => res.once("drain", resolve));
}

function writeAnthropicError(
  res: {
    writeHead(status: number, headers: Record<string, string>): unknown;
    end(body: string): unknown;
  },
  status: number,
  type: string,
  message: string,
): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
