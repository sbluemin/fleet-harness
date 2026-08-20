import {
  AnthropicMessagesGateway,
  ContextWindowExceededError,
} from "../anthropic/gateway.js";
import {
  anthropicNativeHeaders,
  ANTHROPIC_MESSAGES_URL,
} from "../anthropic/native.js";
import { stripClaudeUsageLimitDirectives } from "../anthropic/claude-context.js";
import type { AnthropicMessagesRequest } from "../anthropic/protocol.js";
import { UnsupportedReasoningEffortError } from "../canonical/index.js";
import { CodexResponsesAdapter } from "../codex/responses/adapter.js";
import { resolveCodexCredentials } from "../codex/credentials.js";
import {
  CursorAdapter,
  CursorRequestBudgetError,
  CursorSessionIdentityError,
} from "../cursor/native/adapter.js";
import type { CursorDiagnosticSink } from "../cursor/native/adapter.js";
import { resolveCursorCredentials } from "../cursor/credentials.js";
import { resolveXaiCliCredentials } from "../xai/credentials.js";
import { XaiResponsesAdapter } from "../xai/responses/adapter.js";
import {
  kimiAnthropicHeaders,
  kimiRequestBody,
  KIMI_MESSAGES_URL,
} from "../kimi/anthropic/index.js";
import {
  buildAnthropicModelList,
  findGatewayModel,
  GATEWAY_MODEL_ALIAS_PREFIX,
  GATEWAY_MODELS,
  upstreamModelId,
} from "../models.js";
import type { GatewayModel } from "../models.js";
import { DEFAULT_XAI_ENDPOINT_PREFERENCE, resolveAiGatewaySelection } from "../settings/index.js";
import type { AiGatewayStoredSettings, XaiEndpointPreference } from "../settings/index.js";
import type { CompactCeiling } from "../anthropic/claude-context.js";
import { defaultCredentialDeps } from "../transport/credentials.js";

import { applyGatewayRequestPolicy } from "./router-policy.js";
import {
  createOpencodeGateway,
  isOpencodeAnthropicPassthrough,
  opencodeGoWire,
  proxyToOpencode,
} from "./opencode.js";
import {
  drain,
  errorMessage,
  proxyAnthropicMessages,
  writeAnthropicError,
  writeSseErrorFrame,
  type GatewayProxyResponse,
} from "./proxy.js";
import type { GatewayHttpHandler } from "./types.js";

export { OPENCODE_GO_MESSAGES_URL as OPENCODE_MESSAGES_URL } from "../opencode-go/index.js";
export { KIMI_MESSAGES_URL } from "../kimi/anthropic/index.js";
export { ANTHROPIC_MESSAGES_URL } from "../anthropic/native.js";

export const AI_GATEWAY_ROUTE_SEGMENT = "ai-gateway";
export const AI_GATEWAY_MODEL_ENV = "FLEET_AI_GATEWAY_MODEL";

/**
 * `/v1/messages` 본문의 상한.
 *
 * 이 리더는 본문을 전부 메모리에 모은 뒤에야 파싱하므로, 상한이 없으면 요청 하나가 호스트
 * 프로세스를 밀어낼 수 있다. Console의 일반 API 리더가 쓰는 1 MiB를 그대로 가져올 수는 없다 —
 * 대화 전체와 인라인 이미지를 매 턴 다시 싣는 이 본문은 정상적으로도 그보다 훨씬 크다.
 * 이 패키지가 큰 JSON에 이미 쓰는 천장(claude-context의 16 MiB)의 두 배로 잡아, 1M 창을
 * 가득 채운 요청까지 통과시키면서 무한 증가만 끊는다.
 */
export const MAX_GATEWAY_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

/** Codex CLI가 ChatGPT 구독 로그인으로 저장해 둔 토큰. */
export interface CodexSubscriptionAuth {
  readonly accessToken: string;
  readonly accountId: string;
}

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

/**
 * Codex CLI 로그인이 남긴 ChatGPT 구독 토큰.
 *
 * 조달 경로는 core-ai-gateway가 단일 출처다. 여기서 직접 `~/.codex/auth.json`을 읽으면
 * `CODEX_HOME`으로 Codex 홈을 옮긴 사용자의 파일을 놓친다 — quota 플러그인은 이미 그 변수를
 * 존중하고 있었다. 게이트웨이는 `chatgpt-account-id` 헤더가 필요하므로 account id가 없는
 * 자격증명은 여기서 사용 불가로 판정한다.
 */
export async function readXaiSubscriptionToken(): Promise<string | null> {
  const credentials = await resolveXaiCliCredentials(defaultCredentialDeps);
  return credentials?.accessToken ?? null;
}

export async function readCodexSubscriptionAuth(): Promise<CodexSubscriptionAuth | null> {
  const credentials = await resolveCodexCredentials(defaultCredentialDeps);
  if (!credentials?.accountId) return null;
  return { accessToken: credentials.accessToken, accountId: credentials.accountId };
}

export interface AiGatewayRouteDeps {
  readonly originator: string;
  /** core-ai-gateway 설정의 노출 모델 선별을 읽는다. 미주입(테스트 하네스)이면 전체 카탈로그를 노출한다. */
  readonly readAiGatewaySettings?: () => AiGatewayStoredSettings;
  /** 테스트가 upstream을 대체할 수 있도록 주입 가능하게 둔다. */
  readonly gateway?: AnthropicMessagesGateway;
  // 자격증명 조달은 호스트 관심사다. 이 패키지는 기본 조회를 갖지 않으며(환경·홈·키체인
  // 접근 금지), 각 호스트가 export된 reader를 명시 주입한다.
  readonly readAuth: () => CodexSubscriptionAuth | null | Promise<CodexSubscriptionAuth | null>;
  readonly readCursorToken: () => string | null | Promise<string | null>;
  readonly readXaiToken?: () => string | null | Promise<string | null>;
  readonly readKimiApiKey?: () => Promise<string | undefined>;
  readonly readOpencodeApiKey?: () => Promise<string | undefined>;
  readonly readModelOverride?: () => string | undefined;
  readonly cursorDiagnostics?: CursorDiagnosticSink;
  readonly fetch?: typeof fetch;
}

export interface AiGatewayRouter {
  readonly handle: GatewayHttpHandler;
  /** Dispose only router-owned provider state; injected gateways remain externally owned. */
  dispose(): void;
}

export function createAiGatewayRouter(deps: AiGatewayRouteDeps): AiGatewayRouter {
  const readAuth = deps.readAuth;
  const fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const ownedCursorAdapter = deps.gateway
    ? undefined
    : new CursorAdapter({ diagnostics: deps.cursorDiagnostics });
  const ownedCursorGateway = ownedCursorAdapter
    ? new AnthropicMessagesGateway(ownedCursorAdapter)
    : undefined;
  // 창을 감당 못 해 본문이 한 번 보류된 스킬들. 이 라우터가 사는 동안 유지해야
  // 다음 세션의 첫 요청부터 목록에서 빠진다 — 프로세스당 한 번만 낭비되는 턴이 된다.
  const withheldSkills = new Set<string>();
  // 설정 리더가 있으면 노출은 opt-in(켠 모델만)이다. 미주입(테스트 하네스 등)일 때만
  // 전체 카탈로그로 동작한다 — Console 배선(routes.ts)은 항상 리더를 주입한다.
  const gatewaySettings = (): AiGatewayStoredSettings | undefined => (
    deps.readAiGatewaySettings ? deps.readAiGatewaySettings() : undefined
  );
  // 요청이 지목한 모델이 사용자가 켠 선별 안에 있는지 본다. 설정 리더가 없으면 노출이
  // 곧 전체 카탈로그이므로(위 gatewaySettings 주석) 항상 참이다. 별칭·1M 마커로 들어와도
  // findGatewayModel이 카탈로그 항목으로 정규화한 뒤이므로 id 비교로 충분하다.
  const isModelExposed = (model: GatewayModel): boolean => {
    let settings: AiGatewayStoredSettings | undefined;
    try {
      settings = gatewaySettings();
    } catch {
      // 설정 판독 실패는 기능을 낮출 뿐 요청을 막지 않는다 — cursorDiagnosticsEnabled가 이미
      // 택한 규율이고, 그 계약은 "설정을 못 읽어도 Cursor를 막지 않는다"로 테스트에 박혀 있다.
      // 파일 하나가 깨졌다고 모든 실행이 죽는 편이 끈 모델 한 번보다 나쁘다.
      return true;
    }
    if (!settings) return true;
    return resolveAiGatewaySelection(settings).models.some((entry) => entry.id === model.id);
  };
  const cursorDiagnosticsEnabled = (): boolean | undefined => {
    if (!deps.readAiGatewaySettings) return undefined;
    try {
      return deps.readAiGatewaySettings().cursorDiagnosticsEnabled === true;
    } catch {
      // 진단 설정 판독 실패는 모델 요청을 막지 않고 안전한 기본값 Off로 단락한다.
      return false;
    }
  };
  const xaiEndpoint = (): XaiEndpointPreference => {
    if (!deps.readAiGatewaySettings) return DEFAULT_XAI_ENDPOINT_PREFERENCE;
    try {
      return deps.readAiGatewaySettings().xaiEndpoint ?? DEFAULT_XAI_ENDPOINT_PREFERENCE;
    } catch {
      // A settings read that fails must not decide the endpoint for the user; fall back to the
      // documented default rather than to whichever branch happens to be cheaper.
      return DEFAULT_XAI_ENDPOINT_PREFERENCE;
    }
  };
  const compactCeiling = (): CompactCeiling | undefined => {
    try {
      return gatewaySettings()?.compactCeiling;
    } catch {
      return undefined;
    }
  };

  const handle: GatewayHttpHandler = async ({ req, res, pathname }) => {
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
      const settings = gatewaySettings();
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
      body = await readJsonBody<AnthropicMessagesRequest>(req, MAX_GATEWAY_REQUEST_BODY_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        // 413이되 "context window"는 담지 않는다 — 그 문구는 Claude Code의 반응형 압축을 무장시키는
        // 별도 계약(canonical/index.ts ContextWindowExceededError)이고, 큰 본문이 곧 창 초과는 아니다.
        writeAnthropicError(res, 413, "invalid_request_error", `Request body exceeds the gateway limit of ${error.maxBytes} bytes.`);
        return true;
      }
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
    const modelOverride = deps.readModelOverride?.();
    const requested = modelOverride ?? body.model;
    const target = findGatewayModel(requested);
    if (!target && requested.startsWith(GATEWAY_MODEL_ALIAS_PREFIX)) {
      writeAnthropicError(res, 400, "invalid_request_error", `Unknown AI gateway model: ${requested}`);
      return true;
    }
    // 디스커버리(/v1/models)가 켠 모델만 광고해도 실행 경로가 카탈로그 전체를 받아 주면, raw id를
    // 아는 호출자는 사용자가 끈 모델로 그 구독을 그대로 쓴다. 선별은 광고 목록이 아니라 지출 계약이므로
    // 여기서 함께 강제한다. env 오버라이드는 예외다 — 그 값을 세팅한 주체는 이 프로세스의 운영자이고,
    // 선별 파일의 주인과 같은 사람이라 호출자 입력과 같은 신뢰 등급이 아니다.
    if (target && modelOverride === undefined && !isModelExposed(target)) {
      writeAnthropicError(res, 403, "permission_error", `AI gateway model is not enabled: ${requested}`);
      return true;
    }

    // 하네스가 자기 Anthropic 계정의 한도 임박을 근거로 대화에 끼워 넣는 마무리 지시는 여기서 끊는다.
    // 그 지시는 이 턴을 실제로 결제하는 구독을 설명하지 않으므로, 목적지를 가리지 않고 전량 제거한다 —
    // 근거와 모양 판정은 claude-context.ts가 갖는다. 공급자별 판단이 아니므로 아래 정책으로 내려가지
    // 않는다: 게이트웨이 대상이 없는 네이티브 Anthropic까지 덮어야 하는 유일한 다듬기다.
    const withoutUsageLimitDirectives = stripClaudeUsageLimitDirectives(body.messages);
    if (withoutUsageLimitDirectives.changed) {
      body = { ...body, messages: [...withoutUsageLimitDirectives.messages] };
    }
    // 그 밖에 요청을 어떻게 다듬을지는 공급자가 자기 폴더에서 선언한다. 여기는 그 결정을
    // 실행할 뿐 어느 공급자가 무엇을 받는지 알지 않는다.
    if (target) body = applyGatewayRequestPolicy(body, target, withheldSkills);

    let credential = "";
    let chatgptAccountId = "";
    if (target?.provider === "cursor") {
      const cursorToken = await deps.readCursorToken();
      if (!cursorToken) {
        writeAnthropicError(res, 401, "authentication_error", "No Cursor subscription token was found. Sign in to Cursor first.");
        return true;
      }
      credential = cursorToken;
    } else if (target?.provider === "codex") {
      // ChatGPT 구독 토큰은 Codex CLI가 저장해 둔 것을 읽는다. 자식에게는 넘기지 않는다.
      const auth = await readAuth();
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
    } else if (target?.provider === "opencode") {
      const opencodeApiKey = await deps.readOpencodeApiKey?.();
      if (!opencodeApiKey) {
        writeAnthropicError(res, 401, "authentication_error", "No OpenCode Go API key was found. Sign in to OpenCode Go first.");
        return true;
      }
      credential = opencodeApiKey;
    } else if (target?.provider === "xai") {
      const xaiToken = await deps.readXaiToken?.();
      if (!xaiToken) {
        writeAnthropicError(res, 401, "authentication_error", "No active Grok CLI sign-in was found. Run `grok login` first.");
        return true;
      }
      credential = xaiToken;
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
      // Claude Code meters every custom model on either its unmarked 200k coordinate
      // or the truthful `[1m]` coordinate. Pass the real catalog window for both: the
      // compatibility seam removes only the capacity above Claude's chosen coordinate,
      // so each model reaches its real window minus Claude's own compaction reserve.
      const claudeContextWindow = target.contextWindow;
      const ceiling = compactCeiling();
      if (target.provider === "kimi") {
        await proxyToKimi(
          req.headers,
          res,
          body,
          upstreamModelId(target),
          claudeContextWindow,
          ceiling,
          credential,
          fetchImpl,
          controller.signal,
        );
        return true;
      }
      if (target.provider === "opencode" && isOpencodeAnthropicPassthrough(target)) {
        await proxyToOpencode(
          req.headers,
          res,
          body,
          upstreamModelId(target),
          claudeContextWindow,
          ceiling,
          credential,
          fetchImpl,
          controller.signal,
        );
        return true;
      }
      const gateway = deps.gateway
        ?? (target.provider === "cursor"
          ? ownedCursorGateway!
          : target.provider === "opencode"
            ? createOpencodeGateway(opencodeGoWire(target) as "responses" | "chat-completions")
            : target.provider === "xai"
              ? new AnthropicMessagesGateway(new XaiResponsesAdapter({
                fetch: fetchImpl,
                endpoint: xaiEndpoint(),
              }))
              : createGatewayFor(target, chatgptAccountId, deps.originator));
      const diagnosticsEnabled = target.provider === "cursor"
        ? cursorDiagnosticsEnabled()
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
        ...(ceiling === undefined ? {} : { compactCeiling: ceiling }),
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
      // Claude Code arms reactive compaction only from a 413 whose message names the
      // context window; a 400 carrying the same text ends the turn instead. Everything
      // else keeps 400 — a Cursor transport-budget refusal is not an overflow, and
      // reporting it as one would send the client compacting after the wrong thing.
      const status = error instanceof ContextWindowExceededError ? 413 : invalidRequest ? 400 : 502;
      const message = errorMessage(error);
      if (res.headersSent) {
        // 헤더를 보낸 뒤에는 상태 코드를 바꿀 수 없다. 그냥 끊으면 클라이언트는
        // 오류 문구 없는 잘린 스트림만 보므로, 종단 SSE error 프레임으로 사유를 남긴다.
        writeSseErrorFrame(res, type, message);
        res.end();
      } else {
        writeAnthropicError(res, status, type, message);
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

/** Anthropic 모델은 번역하지 않는다. 요청 본문과 응답 스트림을 그대로 통과시킨다. */
async function proxyToAnthropic(
  requestHeaders: Record<string, unknown>,
  res: GatewayProxyResponse,
  body: AnthropicMessagesRequest,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<void> {
  // 헤더·URL 정책은 core-ai-gateway가 소유한다. 여기는 요청을 실어 보낼 뿐이다.
  const headers = anthropicNativeHeaders(requestHeaders);
  await proxyAnthropicMessages(res, body, {
    keepAlive: true,
    fetchImpl,
    headers,
    signal,
    url: ANTHROPIC_MESSAGES_URL,
    wireEventLabel: "anthropic.wire.event",
  });
}

async function proxyToKimi(
  requestHeaders: Record<string, unknown>,
  res: GatewayProxyResponse,
  body: AnthropicMessagesRequest,
  model: string,
  contextWindow: number | undefined,
  compactCeiling: CompactCeiling | undefined,
  apiKey: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<void> {
  // 헤더·본문 정책은 core-ai-gateway가 소유한다. 여기는 요청을 실어 보낼 뿐이다.
  const headers = kimiAnthropicHeaders(requestHeaders, apiKey);
  // 클라이언트 요청 model은 provider wire id로 재작성되기 전 원본을 에코용으로 남긴다.
  const responseModel = typeof body.model === "string" ? body.model : undefined;
  await proxyAnthropicMessages(res, kimiRequestBody(body, model), {
    contextWindow,
    compactCeiling,
    responseModel,
    keepAlive: true,
    fetchImpl,
    headers,
    signal,
    url: KIMI_MESSAGES_URL,
    wireEventLabel: "kimi-anthropic.wire.event",
  });
}

function createGatewayFor(
  model: GatewayModel,
  chatgptAccountId: string,
  originator: string,
): AnthropicMessagesGateway {
  if (model.provider !== "codex") {
    throw new TypeError(`Unsupported translated gateway provider: ${model.provider}`);
  }
  return new AnthropicMessagesGateway(new CodexResponsesAdapter({
    accountId: chatgptAccountId,
    headers: { originator },
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
}, maxBytes: number): Promise<T | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buffer.length;
    // 파싱 전에 끊는다. 다 모은 뒤 크기를 보면 이미 그만큼 실린 뒤다.
    if (total > maxBytes) throw new RequestBodyTooLargeError(maxBytes);
    chunks.push(buffer);
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
