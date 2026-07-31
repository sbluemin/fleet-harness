import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AnthropicMessagesGateway,
  CHATGPT_CODEX_RESPONSES_URL,
  CursorAdapter,
  GATEWAY_MODELS,
  OpenAIResponsesAdapter,
  buildAnthropicModelList,
  findGatewayModel,
  upstreamModelId,
} from "@dotobokuri/core-ai-gateway";
import type { GatewayModel } from "@dotobokuri/core-ai-gateway";
import type { AnthropicMessagesRequest } from "@dotobokuri/core-ai-gateway";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { registerRouter } from "@fleet-console/sdk/plugin/node";
import type { RouteHandler } from "@fleet-console/sdk/routing";

export const AI_GATEWAY_ROUTE_SEGMENT = "ai-gateway";
export const AI_GATEWAY_EXPERIMENTAL_ENV = "FLEET_EXPERIMENTAL_AI_GATEWAY";
export const AI_GATEWAY_MODEL_ENV = "FLEET_AI_GATEWAY_MODEL";

/** Codex CLI가 ChatGPT 구독 로그인으로 저장해 둔 토큰. */
export interface CodexSubscriptionAuth {
  readonly accessToken: string;
  readonly accountId: string;
}

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
/** Claude Code가 claude.ai 구독으로 붙일 때 보내는 자격증명 접두. OAuth 토큰도 이 접두를 쓴다. */
const ANTHROPIC_CREDENTIAL_PREFIX = "sk-ant-";

/** Claude Code의 claude.ai 구독 로그인이 keychain에 남긴 OAuth 토큰. */
export function readAnthropicSubscriptionToken(): string | null {
  try {
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const parsed = JSON.parse(raw) as { readonly claudeAiOauth?: { readonly accessToken?: unknown } };
    const token = parsed.claudeAiOauth?.accessToken;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** Cursor CLI/IDE 로그인이 keychain에 남긴 구독 토큰. */
export function readCursorSubscriptionToken(): string | null {
  try {
    const token = execFileSync(
      "security",
      ["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export function readCodexSubscriptionAuth(
  authPath: string = path.join(os.homedir(), ".codex", "auth.json"),
): CodexSubscriptionAuth | null {
  try {
    const parsed = JSON.parse(readFileSync(authPath, "utf8")) as {
      readonly tokens?: { readonly access_token?: unknown; readonly account_id?: unknown };
    };
    const accessToken = parsed.tokens?.access_token;
    const accountId = parsed.tokens?.account_id;
    if (typeof accessToken !== "string" || accessToken.length === 0) return null;
    if (typeof accountId !== "string" || accountId.length === 0) return null;
    return { accessToken, accountId };
  } catch {
    return null;
  }
}

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
  /** 테스트가 upstream을 대체할 수 있도록 주입 가능하게 둔다. */
  readonly gateway?: AnthropicMessagesGateway;
  /** 테스트가 구독 토큰 조회를 대체한다. */
  readonly readAuth?: () => CodexSubscriptionAuth | null;
  readonly readCursorToken?: () => string | null;
  readonly readAnthropicToken?: () => string | null;
}

export interface AiGatewayRouter extends AiGatewayTokenIssuer {
  readonly handle: RouteHandler;
}

export function isAiGatewayEnabled(): boolean {
  return process.env[AI_GATEWAY_EXPERIMENTAL_ENV] === "1";
}

export function createAiGatewayRouter(deps: AiGatewayRouteDeps = {}): AiGatewayRouter {
  const readAuth = deps.readAuth ?? (() => readCodexSubscriptionAuth());

  const handle: RouteHandler = async ({ req, res, pathname }) => {
    // Experimental 진단: Claude Code가 실제로 무엇을 호출하는지 관찰한다.
    console.log(`[ai-gateway] ${req.method} ${pathname} auth=${req.headers.authorization ? "yes" : "no"}`);
    // Claude Code는 base URL 뒤에 자기 경로를 붙인다. 연결 프로브는 /api/hello다.
    if (pathname.endsWith("/api/hello")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return true;
    }
    // Claude Code의 gateway model discovery. 이게 있어야 /model picker에 GPT가 뜬다.
    if (pathname.endsWith("/v1/models")) {
      if (!callerAnthropicCredential(req.headers)) {
        writeAnthropicError(res, 401, "authentication_error", "Missing Anthropic credential");
        return true;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(buildAnthropicModelList()));
      return true;
    }
    if (!pathname.endsWith("/v1/messages")) return false;
    if (req.method !== "POST") {
      writeAnthropicError(res, 405, "invalid_request_error", "Method not allowed");
      return true;
    }
    const callerCredential = callerAnthropicCredential(req.headers);
    if (!callerCredential) {
      writeAnthropicError(res, 401, "authentication_error", "Missing Anthropic credential");
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

    console.log(
      `[ai-gateway] body keys=${JSON.stringify(Object.keys(body))}`
      + ` system=${Array.isArray(body.system) ? `array(${body.system.length})` : typeof body.system}`
      + ` msgRoles=${JSON.stringify((body.messages ?? []).map((m) => m.role))}`,
    );

    // 요청이 지목한 모델이 어느 구독으로 가는지 정한다. env 오버라이드가 있으면 그쪽이 이긴다.
    const requested = process.env[AI_GATEWAY_MODEL_ENV] ?? body.model;
    const target = findGatewayModel(requested);

    // 카탈로그 밖의 모델은 Anthropic 자기 모델이다. 호출자의 자격증명을 그대로 실어 원문 중계한다.
    if (!target) {
      await proxyToAnthropic(req, res, body);
      return true;
    }

    let credential: string;
    let chatgptAccountId = "";
    if (target.provider === "cursor") {
      const cursorToken = (deps.readCursorToken ?? readCursorSubscriptionToken)();
      if (!cursorToken) {
        writeAnthropicError(res, 401, "authentication_error", "No Cursor subscription token was found. Sign in to Cursor first.");
        return true;
      }
      credential = cursorToken;
    } else {
      // ChatGPT 구독 토큰은 Codex CLI가 저장해 둔 것을 읽는다. 자식에게는 넘기지 않는다.
      const auth = readAuth();
      if (!auth) {
        writeAnthropicError(res, 401, "authentication_error", "No ChatGPT subscription token was found. Run `codex login` first.");
        return true;
      }
      credential = auth.accessToken;
      chatgptAccountId = auth.accountId;
    }

    const controller = new AbortController();
    const abort = (): void => controller.abort(new Error("client disconnected"));
    req.once("close", abort);

    try {
      const gateway = deps.gateway ?? createGatewayFor(target, chatgptAccountId);
      const upstream = await gateway.stream(body, {
        apiKey: credential,
        signal: controller.signal,
        model: upstreamModelId(target),
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
      // 자체 bearer를 더 이상 쓰지 않는다. Launch 바인딩 계약을 위해 형태만 유지한다.
      return { token: "", revoke: () => undefined };
    },
  };
}

export function registerAiGatewayRoutes(
  ctx: FleetPluginServerContext,
  deps: AiGatewayRouteDeps = {},
): AiGatewayRoutes {
  // Fail-closed: 봉인이 닫혀 있으면 라우트를 등록하지 않아 404로 떨어진다.
  if (!isAiGatewayEnabled()) {
    return { enabled: false, issueToken: rejectIssue };
  }
  const router = createAiGatewayRouter(deps);
  registerRouter(ctx, AI_GATEWAY_ROUTE_SEGMENT, router.handle);
  return { enabled: true, issueToken: router.issueToken };
}

/** Anthropic 모델은 번역하지 않는다. 요청 본문과 응답 스트림을 그대로 통과시킨다. */
async function proxyToAnthropic(
  req: { readonly headers: Record<string, unknown> },
  res: {
    writeHead(status: number, headers: Record<string, string>): unknown;
    write(chunk: Uint8Array): boolean;
    end(body?: string): unknown;
    once(event: "drain", listener: () => void): unknown;
    readonly headersSent: boolean;
  },
  body: AnthropicMessagesRequest,
): Promise<void> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": typeof req.headers["anthropic-version"] === "string" ? req.headers["anthropic-version"] : "2023-06-01",
  };
  // 자격증명을 교체하지 않는다. 청구 주체는 호출자로 남는다.
  for (const name of ["authorization", "x-api-key", "anthropic-beta", "user-agent"]) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }

  const upstream = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const passthroughHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (key === "content-encoding" || key === "content-length" || key === "transfer-encoding") return;
    passthroughHeaders[key] = value;
  });
  res.writeHead(upstream.status, passthroughHeaders);
  if (!upstream.body) {
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!res.write(value)) await drain(res);
  }
  res.end();
}

function createGatewayFor(model: GatewayModel, chatgptAccountId: string): AnthropicMessagesGateway {
  if (model.provider === "cursor") {
    return new AnthropicMessagesGateway(new CursorAdapter());
  }
  return new AnthropicMessagesGateway(new OpenAIResponsesAdapter({
    url: CHATGPT_CODEX_RESPONSES_URL,
    headers: {
      "chatgpt-account-id": chatgptAccountId,
      originator: "fleet-console",
    },
    // ChatGPT 백엔드는 Platform API용 샘플링 파라미터를 400으로 거절한다.
    dropSamplingParams: true,
  }));
}

function rejectIssue(): never {
  throw new Error("The experimental AI gateway is disabled.");
}

/**
 * 호출자가 Claude Code 자신인지 판정한다.
 * 게이트웨이가 자체 bearer를 주입하지 않으므로, 정품 요청은 Claude Code가 들고 있는
 * Anthropic 자격증명(sk-ant-*)을 그대로 실어 온다. 그 값은 Anthropic 원문 중계에도 쓰인다.
 */
export function callerAnthropicCredential(headers: Record<string, unknown>): string | null {
  const raw = headers.authorization;
  const bearer = typeof raw === "string" && /^bearer /i.test(raw) ? raw.slice(7).trim() : "";
  if (bearer.startsWith(ANTHROPIC_CREDENTIAL_PREFIX)) return bearer;
  const apiKey = typeof headers["x-api-key"] === "string" ? headers["x-api-key"].trim() : "";
  return apiKey.startsWith(ANTHROPIC_CREDENTIAL_PREFIX) ? apiKey : null;
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
