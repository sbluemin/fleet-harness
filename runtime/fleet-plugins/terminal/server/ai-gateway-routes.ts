import { randomBytes, timingSafeEqual } from "node:crypto";
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

const TOKEN_BYTES = 32;

/** Codex CLI가 ChatGPT 구독 로그인으로 저장해 둔 토큰. */
export interface CodexSubscriptionAuth {
  readonly accessToken: string;
  readonly accountId: string;
}

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

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
  const tokens = new Set<string>();
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
      if (!authorize(req.headers.authorization, tokens)) {
        writeAnthropicError(res, 401, "authentication_error", "Invalid gateway token");
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
    if (!authorize(req.headers.authorization, tokens)) {
      writeAnthropicError(res, 401, "authentication_error", "Invalid gateway token");
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

    // 카탈로그 밖의 모델은 Anthropic 자기 모델이다. 변환 없이 구독으로 원문 중계한다.
    if (!target) {
      const anthropicToken = (deps.readAnthropicToken ?? readAnthropicSubscriptionToken)();
      if (!anthropicToken) {
        writeAnthropicError(res, 401, "authentication_error", "No Anthropic subscription token was found. Run `claude` and sign in first.");
        return true;
      }
      await proxyToAnthropic(req, res, body, anthropicToken);
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
      const token = randomBytes(TOKEN_BYTES).toString("hex");
      tokens.add(token);
      return { token, revoke: () => void tokens.delete(token) };
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
  token: string,
): Promise<void> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "anthropic-version": typeof req.headers["anthropic-version"] === "string" ? req.headers["anthropic-version"] : "2023-06-01",
  };
  const beta = req.headers["anthropic-beta"];
  if (typeof beta === "string") headers["anthropic-beta"] = beta;

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
