import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AnthropicMessagesGateway,
  CHATGPT_CODEX_RESPONSES_URL,
  ContextWindowExceededError,
  CursorAdapter,
  CursorRequestBudgetError,
  CursorSessionIdentityError,
  GATEWAY_MODEL_ALIAS_PREFIX,
  GATEWAY_MODELS,
  OpenAIResponsesAdapter,
  UnsupportedReasoningEffortError,
  buildAnthropicModelList,
  clampReasoningEffort,
  defaultCredentialDeps,
  findGatewayModel,
  hasClaudeOneMillionMarker,
  projectAnthropicResponseUsage,
  reasoningEffortFromOutputConfig,
  resolveCursorCredentials,
  toClaudeGatewayModelId,
  upstreamModelId,
} from "@dotobokuri/core-ai-gateway";
import type {
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicToolDefinition,
  CursorDiagnosticSink,
  GatewayModel,
  ReasoningEffort,
} from "@dotobokuri/core-ai-gateway";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { registerRouter } from "@fleet-console/sdk/plugin/node";
import type { RouteHandler } from "@fleet-console/sdk/routing";

import { createCursorDiagnosticLog } from "./ai-gateway-diagnostics.js";
import { resolveAiGatewaySelection, type AiGatewayStoredSettings } from "./ai-gateway-settings.js";

export const AI_GATEWAY_ROUTE_SEGMENT = "ai-gateway";
export const AI_GATEWAY_MODEL_ENV = "FLEET_AI_GATEWAY_MODEL";

/** Codex CLI가 ChatGPT 구독 로그인으로 저장해 둔 토큰. */
export interface CodexSubscriptionAuth {
  readonly accessToken: string;
  readonly accountId: string;
}

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const KIMI_MESSAGES_URL = "https://api.kimi.com/coding/v1/messages";
/** Claude Code가 claude.ai 구독으로 붙일 때 보내는 자격증명 접두. OAuth 토큰도 이 접두를 쓴다. */
const ANTHROPIC_CREDENTIAL_PREFIX = "sk-ant-";

/**
 * Cursor CLI/IDE 로그인이 남긴 구독 토큰.
 *
 * 조달 경로는 core-ai-gateway가 단일 출처다. macOS는 keychain을 먼저 보고, Linux/Windows는
 * 각 플랫폼의 auth.json을 읽는다. 여기서 keychain만 보면 `security`가 없는 Linux/WSL에서
 * 항상 토큰 없음으로 떨어져 Cursor 모델 호출이 401이 된다.
 */
export async function readCursorSubscriptionToken(): Promise<string | null> {
  const credentials = await resolveCursorCredentials(defaultCredentialDeps);
  return credentials?.accessToken ?? null;
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

export interface AiGatewayRouteDeps {
  /** 콘솔 durable state의 노출 모델 선별을 읽는다. 미주입(테스트 하네스)이면 전체 카탈로그를 노출한다. */
  readonly readAiGatewaySettings?: () => Promise<AiGatewayStoredSettings>;
  /** 테스트가 upstream을 대체할 수 있도록 주입 가능하게 둔다. */
  readonly gateway?: AnthropicMessagesGateway;
  /** 테스트가 구독 토큰 조회를 대체한다. */
  readonly readAuth?: () => CodexSubscriptionAuth | null;
  readonly readCursorToken?: () => string | null | Promise<string | null>;
  readonly readKimiApiKey?: () => Promise<string | undefined>;
  readonly cursorDiagnostics?: CursorDiagnosticSink;
  readonly fetch?: typeof fetch;
}

export interface AiGatewayRouter {
  readonly handle: RouteHandler;
  /** Dispose only router-owned provider state; injected gateways remain externally owned. */
  dispose(): void;
}

export function createAiGatewayRouter(deps: AiGatewayRouteDeps = {}): AiGatewayRouter {
  const readAuth = deps.readAuth ?? (() => readCodexSubscriptionAuth());
  const fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const ownedCursorAdapter = deps.gateway
    ? undefined
    : new CursorAdapter({ diagnostics: deps.cursorDiagnostics });
  const ownedCursorGateway = ownedCursorAdapter
    ? new AnthropicMessagesGateway(ownedCursorAdapter)
    : undefined;
  // 설정 리더가 있으면 노출은 opt-in(켠 모델만)이다. 미주입(테스트 하네스 등)일 때만
  // 전체 카탈로그로 동작한다 — Console 배선(routes.ts)은 항상 리더를 주입한다.
  const gatewaySettings = async (): Promise<AiGatewayStoredSettings | undefined> => (
    deps.readAiGatewaySettings ? deps.readAiGatewaySettings() : undefined
  );
  const cursorDiagnosticsEnabled = async (): Promise<boolean | undefined> => {
    if (!deps.readAiGatewaySettings) return undefined;
    try {
      return (await deps.readAiGatewaySettings()).cursorDiagnosticsEnabled === true;
    } catch {
      // 진단 설정 판독 실패는 모델 요청을 막지 않고 안전한 기본값 Off로 단락한다.
      return false;
    }
  };

  const handle: RouteHandler = async ({ req, res, pathname }) => {
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
      const settings = await gatewaySettings();
      res.end(JSON.stringify(buildAnthropicModelList(
        settings ? resolveAiGatewaySelection(settings).models : GATEWAY_MODELS,
      )));
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
    if (typeof body.model !== "string" || body.model.trim().length === 0) {
      writeAnthropicError(res, 400, "invalid_request_error", "Request model must be a non-empty string");
      return true;
    }

    // 요청이 지목한 모델이 어느 구독으로 가는지 정한다. env 오버라이드가 있으면 그쪽이 이긴다.
    const requested = process.env[AI_GATEWAY_MODEL_ENV] ?? body.model;
    const target = findGatewayModel(requested);
    if (!target && requested.startsWith(GATEWAY_MODEL_ALIAS_PREFIX)) {
      writeAnthropicError(res, 400, "invalid_request_error", `Unknown AI gateway model: ${requested}`);
      return true;
    }

    let credential = "";
    let chatgptAccountId = "";
    if (target?.provider === "cursor") {
      const cursorToken = await (deps.readCursorToken ?? readCursorSubscriptionToken)();
      if (!cursorToken) {
        writeAnthropicError(res, 401, "authentication_error", "No Cursor subscription token was found. Sign in to Cursor first.");
        return true;
      }
      credential = cursorToken;
    } else if (target?.provider === "codex") {
      // ChatGPT 구독 토큰은 Codex CLI가 저장해 둔 것을 읽는다. 자식에게는 넘기지 않는다.
      const auth = readAuth();
      if (!auth) {
        writeAnthropicError(res, 401, "authentication_error", "No ChatGPT subscription token was found. Run `codex login` first.");
        return true;
      }
      credential = auth.accessToken;
      chatgptAccountId = auth.accountId;
    } else if (target?.provider === "kimi") {
      const kimiApiKey = await deps.readKimiApiKey?.();
      if (!kimiApiKey) {
        writeAnthropicError(res, 401, "authentication_error", "No Kimi API key was found. Sign in to Kimi Code first.");
        return true;
      }
      credential = kimiApiKey;
    }

    const controller = new AbortController();
    const abort = (): void => controller.abort(new Error("client disconnected"));
    req.once("close", abort);

    try {
      if (!target) {
        // Native Anthropic models keep the caller-owned credential and wire request unchanged.
        await proxyToAnthropic(req.headers, res, body, fetchImpl, controller.signal);
        return true;
      }
      // Claude Code may strip the discovery-only `[1m]` suffix before sending a
      // request. Derive the projection denominator from the resolved registry
      // model so every alias for the same Cursor/Codex model projects usage in
      // the same way. It is the model's real window: projecting against anything
      // smaller maps the remaining capacity above 100% of the 1M coordinate,
      // which Claude Code reads as an exceeded context and will not compact.
      const claudeContextWindow = hasClaudeOneMillionMarker(toClaudeGatewayModelId(target))
        ? target.contextWindow
        : undefined;
      if (target.provider === "kimi") {
        await proxyToKimi(
          req.headers,
          res,
          body,
          upstreamModelId(target),
          claudeContextWindow,
          credential,
          fetchImpl,
          controller.signal,
        );
        return true;
      }
      const gateway = deps.gateway
        ?? (target.provider === "cursor"
          ? ownedCursorGateway!
          : createGatewayFor(target, chatgptAccountId));
      const diagnosticsEnabled = target.provider === "cursor"
        ? await cursorDiagnosticsEnabled()
        : undefined;
      // The guard runs regardless of the `[1m]` coordinate: a 200000-window Cursor
      // model carries no marker but still needs to be refused before it overflows.
      const modelContextWindow = typeof target.contextWindow === "number"
        && Number.isFinite(target.contextWindow)
        && target.contextWindow > 0
        ? target.contextWindow
        : undefined;
      const upstream = await gateway.stream(body, {
        apiKey: credential,
        ...(claudeContextWindow ? { contextWindow: claudeContextWindow } : {}),
        ...(modelContextWindow === undefined ? {} : { modelContextWindow }),
        ...(diagnosticsEnabled === undefined ? {} : { diagnosticsEnabled }),
        signal: controller.signal,
        model: upstreamModelId(target),
        ...(target.serviceTier ? { serviceTier: target.serviceTier } : {}),
        // Cursor encodes effort in its wire model id and owns its model-specific
        // strict downward clamp in the adapter. Preserve Claude Code's raw effort
        // until that boundary instead of clamping it twice.
        ...(target.provider !== "cursor" && target.effort.supported
          ? { reasoningEfforts: target.effort.levels }
          : {}),
      });
      res.writeHead(upstream.status, headerEntries(upstream.headers));
      for await (const chunk of upstream.body) {
        if (!res.write(chunk)) await drain(res);
      }
      res.end();
    } catch (error) {
      const invalidRequest = error instanceof CursorRequestBudgetError
        || error instanceof CursorSessionIdentityError
        || error instanceof UnsupportedReasoningEffortError
        || error instanceof ContextWindowExceededError;
      const type = invalidRequest ? "invalid_request_error" : "api_error";
      const message = errorMessage(error);
      if (res.headersSent) {
        // 헤더를 보낸 뒤에는 상태 코드를 바꿀 수 없다. 그냥 끊으면 클라이언트는
        // 오류 문구 없는 잘린 스트림만 보므로, 종단 SSE error 프레임으로 사유를 남긴다.
        writeSseErrorFrame(res, type, message);
        res.end();
      } else {
        writeAnthropicError(res, invalidRequest ? 400 : 502, type, message);
      }
    } finally {
      req.off("close", abort);
    }
    return true;
  };

  return {
    handle,
    dispose: () => ownedCursorAdapter?.dispose(),
  };
}

export function registerAiGatewayRoutes(
  ctx: FleetPluginServerContext,
  deps: AiGatewayRouteDeps = {},
): void {
  const ownedDiagnostics = deps.cursorDiagnostics
    ? undefined
    : createCursorDiagnosticLog(ctx.host.paths.pluginDataDir(ctx.pluginId));
  const router = createAiGatewayRouter({
    ...deps,
    cursorDiagnostics: deps.cursorDiagnostics ?? ownedDiagnostics?.write,
  });
  ctx.host.lifecycle.registerCleanup(() => {
    router.dispose();
    return ownedDiagnostics?.flush();
  });
  registerRouter(ctx, AI_GATEWAY_ROUTE_SEGMENT, router.handle);
}

/** Anthropic 모델은 번역하지 않는다. 요청 본문과 응답 스트림을 그대로 통과시킨다. */
async function proxyToAnthropic(
  requestHeaders: Record<string, unknown>,
  res: GatewayProxyResponse,
  body: AnthropicMessagesRequest,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<void> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": typeof requestHeaders["anthropic-version"] === "string"
      ? requestHeaders["anthropic-version"]
      : "2023-06-01",
  };
  // 자격증명을 교체하지 않는다. 청구 주체는 호출자로 남는다.
  for (const name of ["authorization", "x-api-key", "anthropic-beta", "user-agent"]) {
    const value = requestHeaders[name];
    if (typeof value === "string") headers[name] = value;
  }
  await proxyAnthropicMessages(res, body, {
    fetchImpl,
    headers,
    signal,
    url: ANTHROPIC_MESSAGES_URL,
  });
}

async function proxyToKimi(
  requestHeaders: Record<string, unknown>,
  res: GatewayProxyResponse,
  body: AnthropicMessagesRequest,
  model: string,
  contextWindow: number | undefined,
  apiKey: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<void> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": typeof requestHeaders["anthropic-version"] === "string"
      ? requestHeaders["anthropic-version"]
      : "2023-06-01",
    "x-api-key": apiKey,
  };
  for (const name of ["anthropic-beta", "user-agent"]) {
    const value = requestHeaders[name];
    if (typeof value === "string") headers[name] = value;
  }
  await proxyAnthropicMessages(res, kimiRequestBody(body, model), {
    contextWindow,
    fetchImpl,
    headers,
    signal,
    url: KIMI_MESSAGES_URL,
  });
}

const KIMI_REASONING_EFFORTS = ["low", "high", "max"] as const satisfies readonly ReasoningEffort[];

/** K3 accepts three native effort tiers; normalize Claude Code's wider picker ladder. */
function kimiRequestBody(body: AnthropicMessagesRequest, model: string): AnthropicMessagesRequest {
  const eagerBody: AnthropicMessagesRequest = {
    ...body,
    model,
    messages: body.messages.map(kimiEagerMessage),
    ...(body.tools === undefined ? {} : { tools: body.tools.map(kimiEagerTool) }),
  };
  const effort = reasoningEffortFromOutputConfig(body.output_config);
  if (effort === undefined) {
    return eagerBody;
  }
  return {
    ...eagerBody,
    output_config: {
      ...body.output_config,
      effort: clampReasoningEffort(effort, KIMI_REASONING_EFFORTS, model),
    },
  };
}

function kimiEagerTool(tool: AnthropicToolDefinition): AnthropicToolDefinition {
  if (!("input_schema" in tool)) return tool;
  const { defer_loading: _deferLoading, ...eagerTool } = tool;
  return eagerTool;
}

function kimiEagerMessage(message: AnthropicMessage): AnthropicMessage {
  if (typeof message.content === "string") return message;
  return {
    ...message,
    content: message.content.map((block) => {
      if (block.type !== "tool_result" || !Array.isArray(block.content)) return block;
      return {
        ...block,
        content: block.content.map((result) => {
          if (result.type !== "tool_reference") return result;
          const toolName = typeof result.tool_name === "string" && result.tool_name.length > 0
            ? result.tool_name
            : "(invalid reference)";
          return { type: "text" as const, text: `Tool available: ${toolName}` };
        }),
      };
    }),
  };
}

interface GatewayProxyResponse {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: Uint8Array): boolean;
  end(body?: string): unknown;
  once(event: "drain", listener: () => void): unknown;
  readonly headersSent: boolean;
}

interface AnthropicProxyOptions {
  readonly contextWindow?: number;
  readonly fetchImpl: typeof fetch;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly url: string;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

async function proxyAnthropicMessages(
  res: GatewayProxyResponse,
  body: AnthropicMessagesRequest,
  options: AnthropicProxyOptions,
): Promise<void> {
  const upstream = await options.fetchImpl(options.url, {
    method: "POST",
    headers: options.headers,
    body: JSON.stringify(body),
    signal: options.signal,
  });
  const responseHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key)) responseHeaders[key] = value;
  });
  res.writeHead(upstream.status, responseHeaders);
  if (!upstream.body) {
    res.end();
    return;
  }
  const rawBody = readResponseBody(upstream.body);
  const responseBody = options.contextWindow === undefined
    ? rawBody
    : projectAnthropicResponseUsage(rawBody, {
        contentType: upstream.headers.get("content-type"),
        contextWindow: options.contextWindow,
      });
  for await (const chunk of responseBody) {
    if (!res.write(chunk)) await drain(res);
  }
  res.end();
}

async function* readResponseBody(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function createGatewayFor(
  model: GatewayModel,
  chatgptAccountId: string,
): AnthropicMessagesGateway {
  if (model.provider !== "codex") {
    throw new TypeError(`Unsupported translated gateway provider: ${model.provider}`);
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

/**
 * 헤더 전송 후의 유일한 통지 수단. 메시지에 따옴표/개행이 있어도 안전하도록 JSON.stringify로만 만든다.
 *
 * 선행 `\n\n`은 생략할 수 없다. passthrough 경로는 상류 네트워크 청크를 그대로 흘리므로
 * 마지막 청크가 프레임 중간에서 끊길 수 있고, 그 뒤에 곧바로 이어 붙이면 잘린 data 줄에
 * 융합되어 클라이언트 JSON 파싱이 깨진다. 이미 경계에 있을 때 덧붙는 빈 줄은 무해하다.
 */
function writeSseErrorFrame(
  res: { write(chunk: string): boolean },
  type: string,
  message: string,
): void {
  try {
    const data = JSON.stringify({ type: "error", error: { type, message } });
    res.write(`\n\nevent: error\ndata: ${data}\n\n`);
  } catch {
    // 프레임 작성 자체가 실패해도 응답 종료는 막지 않는다.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
