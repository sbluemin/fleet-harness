import { createHash } from "node:crypto";

import {
  AnthropicMessagesGateway,
  ContextWindowExceededError,
} from "../downstream/wire/anthropic-messages/inbound.js";
import {
  anthropicNativeHeaders,
  ANTHROPIC_MESSAGES_URL,
} from "../upstream/anthropic/native.js";
import { claudeCodeHarnessProfile } from "../downstream/harness/claude-code/profile.js";
import type { GatewayHarnessProfile } from "../downstream/harness/contract.js";
import { translateAnthropicRequest } from "../downstream/wire/anthropic-messages/protocol.js";
import type { AnthropicMessagesRequest } from "../downstream/wire/anthropic-messages/protocol.js";
import { AntigravityGenerateContentAdapter } from "../upstream/antigravity/generate-content/adapter.js";
import { resolveAntigravityCredentials } from "../upstream/antigravity/credentials.js";
import { UnsupportedReasoningEffortError } from "../canonical/index.js";
import { CodexResponsesAdapter } from "../upstream/codex/responses/adapter.js";
import { compactCodexConversation } from "../upstream/codex/compaction.js";
import type { ClaudeCodexCompactionStore } from "../upstream/codex/compaction-store.js";
import { resolveCodexCredentials } from "../upstream/codex/credentials.js";
import {
  CursorAdapter,
  CursorRequestBudgetError,
  CursorSessionIdentityError,
} from "../upstream/cursor/native/adapter.js";
import type { CursorDiagnosticSink } from "../upstream/cursor/native/adapter.js";
import { resolveCursorCredentials } from "../upstream/cursor/credentials.js";
import { resolveXaiCliCredentials } from "../upstream/xai/credentials.js";
import { XaiResponsesAdapter } from "../upstream/xai/responses/adapter.js";
import {
  kimiAnthropicHeaders,
  kimiRequestBody,
  KIMI_MESSAGES_URL,
} from "../upstream/kimi/anthropic/index.js";
import {
  GATEWAY_MODELS,
  upstreamModelId,
} from "../models.js";
import type { GatewayModel } from "../models.js";
import { DEFAULT_XAI_ENDPOINT_PREFERENCE, resolveAiGatewaySelection } from "../settings/index.js";
import type { AiGatewayStoredSettings, XaiEndpointPreference } from "../settings/index.js";
import {
  hasClaudeCompactContinuation,
  isClaudeCompactSummaryRequest,
  stripClaudeCompactContinuation,
  stripClaudeCompactPrompt,
} from "../downstream/harness/claude-code/context.js";
import type { CompactCeiling } from "../downstream/harness/claude-code/context.js";
import { defaultCredentialDeps } from "../transport/credentials.js";
import { findCauseCode } from "../transport/upstream-sse.js";
import { createUpstreamGate } from "../transport/upstream-gate.js";
import type { UpstreamGateOriginStats } from "../transport/upstream-gate.js";
import { failureDetail } from "../transport/failure-journal.js";
import type { GatewayFailureSink } from "../transport/failure-journal.js";

import { applyGatewayRequestPolicy } from "./request-policy.js";
import {
  createOpencodeGateway,
  isOpencodeAnthropicPassthrough,
  opencodeGoWire,
  proxyToOpencode,
} from "./opencode-dispatch.js";
import {
  drain,
  errorMessage,
  writeAnthropicError,
  writeSseErrorFrame,
  type GatewayProxyResponse,
} from "./http.js";
import { proxyAnthropicMessages, type AnthropicProxyOptions } from "./passthrough.js";
import type { GatewayHttpHandler } from "./types.js";

/** 패스스루 한 번에 하네스가 얹는 것: 본문 재작성과 상태 승격. */
export type PassthroughRelay = Pick<
  AnthropicProxyOptions,
  "projectResponseBody" | "retryableStatus"
>;

export { OPENCODE_GO_MESSAGES_URL as OPENCODE_MESSAGES_URL } from "../upstream/opencode-go/index.js";
export { KIMI_MESSAGES_URL } from "../upstream/kimi/anthropic/index.js";
export { ANTHROPIC_MESSAGES_URL } from "../upstream/anthropic/native.js";

export const AI_GATEWAY_ROUTE_SEGMENT = "ai-gateway";
export const AI_GATEWAY_MODEL_ENV = "FLEET_AI_GATEWAY_MODEL";

/**
 * 이 와이어가 서빙하는 엔드포인트. 하네스 선택자는 이 접미 **바로 앞** 경로 조각이다.
 *
 * 호스트가 라우터를 어디에 마운트했는지 이 파일은 모른다 — 경로 판정이 전부 접미 비교인
 * 이유이고, 선택자도 같은 규칙 위에 선다. `/ai-gateway/grok/v1/messages`에서 접미
 * `/v1/messages`를 떼면 남는 마지막 조각이 `grok`이다. 마운트 경로에 우연히 같은 이름이
 * 들어 있어도 그것은 접미 바로 앞이 아니므로 선택자가 되지 않는다.
 */
const WIRE_ENDPOINT_SUFFIXES = ["/v1/messages", "/v1/models", "/v1/compact-events"] as const;

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

/**
 * The credential the Antigravity CLI (`agy`) left in the OS credential store.
 *
 * Fleet holds no Antigravity OAuth client and mints no token of its own: `agy
 * login` owns the sign-in, and this reader only decodes what that CLI wrote. A
 * lapsed token is renewed by running the vendor CLI so it renews its own
 * credential, then reading the store again; `forceRenew` asks for that even
 * while the local clock still calls the token healthy, which is what a turn
 * refused upstream with 401/403 needs.
 */
export async function readAntigravitySubscriptionToken(
  options: { readonly forceRenew?: boolean } = {},
): Promise<string | null> {
  const credentials = await resolveAntigravityCredentials(
    defaultCredentialDeps,
    options.forceRenew === true ? { forceRefresh: true } : {},
  );
  return credentials?.accessToken ?? null;
}

export async function readCodexSubscriptionAuth(): Promise<CodexSubscriptionAuth | null> {
  const credentials = await resolveCodexCredentials(defaultCredentialDeps);
  if (!credentials?.accountId) return null;
  return { accessToken: credentials.accessToken, accountId: credentials.accountId };
}

export interface AiGatewayRouteDeps {
  readonly originator: string;
  /**
   * Which client this router serves.
   *
   * Absent is Claude Code — the harness every existing host wires, kept as the default
   * so a host that never names one keeps today's behaviour byte for byte.
   */
  readonly harness?: GatewayHarnessProfile;
  /**
   * 같은 마운트에서 함께 서빙하는 하네스들. 키가 곧 선택자 경로 조각이다.
   *
   * 라우터는 호출자가 누구인지 **판정하지 않는다** — 클라이언트가 자기 base URL에 적어 넣은
   * 조각을 읽을 뿐이다. 그 조각이 없거나 여기 없는 이름이면 기본 하네스가 응답한다.
   * 헤더 스니핑을 쓰지 않는 이유가 이것이다: 스니핑은 라우터에 클라이언트 조건을 되돌려 놓는다.
   */
  readonly harnesses?: Readonly<Record<string, GatewayHarnessProfile>>;
  /** core-ai-gateway 설정의 노출 모델 선별을 읽는다. 미주입(테스트 하네스)이면 전체 카탈로그를 노출한다. */
  readonly readAiGatewaySettings?: () => AiGatewayStoredSettings;
  /** 테스트가 upstream을 대체할 수 있도록 주입 가능하게 둔다. */
  readonly gateway?: AnthropicMessagesGateway;
  // 자격증명 조달은 호스트 관심사다. 이 패키지는 기본 조회를 갖지 않으며(환경·홈·키체인
  // 접근 금지), 각 호스트가 export된 reader를 명시 주입한다.
  readonly readAuth: () => CodexSubscriptionAuth | null | Promise<CodexSubscriptionAuth | null>;
  readonly readCursorToken: () => string | null | Promise<string | null>;
  readonly readXaiToken?: () => string | null | Promise<string | null>;
  readonly readAntigravityToken?: () => string | null | Promise<string | null>;
  /**
   * Re-read the Antigravity credential after the upstream refused it, renewing
   * it first. Absent means a refused token ends the turn, which is what happens
   * for every provider that cannot renew on demand.
   */
  readonly renewAntigravityToken?: () => string | null | Promise<string | null>;
  readonly readKimiApiKey?: () => Promise<string | undefined>;
  readonly readOpencodeApiKey?: () => Promise<string | undefined>;
  readonly readModelOverride?: () => string | undefined;
  /** Host-owned durable state for Claude Code -> Codex compaction. Absent keeps legacy behavior. */
  readonly compactionStore?: ClaudeCodexCompactionStore;
  /** Process-local hook credential injected into Fleet-launched Claude children. */
  readonly compactionHookToken?: string;
  readonly cursorDiagnostics?: CursorDiagnosticSink;
  readonly fetch?: typeof fetch;
  /**
   * Concurrent upstream calls allowed per provider origin, for every provider reached over `fetch`.
   *
   * Those turns hold their socket for the whole stream, so the bound is a real ceiling on
   * simultaneous connections to one origin. Cursor is **not** covered: it dials `http2.connect`
   * per Run rather than `fetch`, so it offers no seam this bound can wrap and keeps its own
   * separate limits. Absent is the transport default.
   */
  readonly maxUpstreamInFlight?: number;
  /**
   * Where failed turns are recorded.
   *
   * A failure after the response commits can only be reported as one SSE frame the client renders
   * once, so without a sink it leaves no trace anywhere. Absent means the gateway keeps no record.
   */
  readonly failureJournal?: GatewayFailureSink;
}

export interface AiGatewayRouter {
  readonly handle: GatewayHttpHandler;
  /** Live upstream occupancy per provider origin. Empty when nothing is in flight. */
  upstreamStats(): readonly UpstreamGateOriginStats[];
  /** Dispose only router-owned provider state; injected gateways remain externally owned. */
  dispose(): void;
}

export function createAiGatewayRouter(deps: AiGatewayRouteDeps): AiGatewayRouter {
  const readAuth = deps.readAuth;
  const defaultHarness = deps.harness ?? claudeCodeHarnessProfile;
  // 선택자 조회는 Map으로 한다. 평범한 객체 인덱싱이면 `toString`·`constructor` 같은
  // 프로토타입 키가 값으로 잡혀, 등록되지 않은 조각이 기본 하네스로 떨어지는 대신
  // 함수 하나를 하네스라고 들고 다음 줄에서 요청 처리를 죽인다.
  const selectableHarnesses = new Map<string, GatewayHarnessProfile>(
    Object.entries(deps.harnesses ?? {}),
  );
  const servedHarnesses = [defaultHarness, ...selectableHarnesses.values()];
  /** 이 요청을 서빙할 하네스. 선택자는 와이어 엔드포인트 바로 앞 경로 조각이다. */
  const harnessForPath = (pathname: string): GatewayHarnessProfile => {
    const suffix = WIRE_ENDPOINT_SUFFIXES.find((candidate) => pathname.endsWith(candidate));
    if (!suffix) return defaultHarness;
    const mounted = pathname.slice(0, pathname.length - suffix.length);
    return selectableHarnesses.get(mounted.slice(mounted.lastIndexOf("/") + 1)) ?? defaultHarness;
  };
  /** The caller's credential, or null when neither header carries one this harness sends. */
  const acceptedCredential = (
    headers: Record<string, unknown>,
    harness: GatewayHarnessProfile,
  ): string | null => (
    callerWireCredentials(headers).find((credential) => harness.acceptsCredential(credential)) ?? null
  );
  // One gate for this router's lifetime. It is the only place that sees every upstream call, so
  // it is also the only place that can bound them or report how many are open.
  const upstreamGate = createUpstreamGate(
    deps.fetch ?? globalThis.fetch.bind(globalThis),
    deps.maxUpstreamInFlight === undefined ? {} : { maxInFlight: deps.maxUpstreamInFlight },
  );
  const fetchImpl = upstreamGate.fetch as typeof fetch;
  const ownedCursorAdapter = deps.gateway
    ? undefined
    : new CursorAdapter({ diagnostics: deps.cursorDiagnostics });
  const ownedCursorGateway = ownedCursorAdapter
    ? new AnthropicMessagesGateway(ownedCursorAdapter)
    : undefined;
  // Antigravity's adapter is built once and kept: it carries the reasoning-blob
  // ledger that lets a turn recover a `thoughtSignature` the client did not
  // replay, and a per-request adapter would forget it between the two halves of
  // one tool round-trip. The gateway wrapper is lazy so a session that never
  // selects an Antigravity model pays nothing for it.
  let ownedAntigravityGateway: AnthropicMessagesGateway | undefined;
  const antigravityGateway = (): AnthropicMessagesGateway => {
    ownedAntigravityGateway ??= new AnthropicMessagesGateway(
      new AntigravityGenerateContentAdapter({
        fetch: fetchImpl,
        ...(deps.renewAntigravityToken
          ? { renewCredential: async () => (await deps.renewAntigravityToken?.()) ?? null }
          : {}),
      }),
    );
    return ownedAntigravityGateway;
  };
  // 창을 감당 못 해 본문이 한 번 보류된 스킬들. 이 라우터가 사는 동안 유지해야
  // 다음 세션의 첫 요청부터 목록에서 빠진다 — 프로세스당 한 번만 낭비되는 턴이 된다.
  const withheldSkills = new Set<string>();
  // Claude Code may retry the same summary request while the first compaction is still
  // in flight. One provider checkpoint per session is the semantic operation; duplicate
  // callers await it rather than spending and racing a second checkpoint into storage.
  const codexCompactionFlights = new Map<
    string,
    ReturnType<typeof compactCodexConversation>
  >();
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
    const harness = harnessForPath(pathname);
    // 클라이언트는 base URL 뒤에 자기 경로를 붙인다. 어느 경로를 먼저 두드리는지는
    // 하네스가 선언한다 — Claude Code는 /api/hello, Grok Build는 아무것도 두드리지 않는다.
    // 프로브는 서빙하는 하네스 전체에 대해 본다: 응답이 빈 객체 하나라 어느 프로필이 그것을
    // 선언했는지가 동작을 가르지 않고, 프로브 경로에는 선택자를 붙일 엔드포인트 접미가 없다.
    if (servedHarnesses.some((profile) => profile.probePaths.some((probePath) => pathname.endsWith(probePath)))) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return true;
    }
    if (pathname.endsWith("/v1/compact-events")) {
      if (req.method !== "POST") {
        writeAnthropicError(res, 405, "invalid_request_error", "Method not allowed");
        return true;
      }
      const hookToken = req.headers["x-fleet-compact-token"];
      if (!deps.compactionStore || !deps.compactionHookToken || hookToken !== deps.compactionHookToken) {
        writeAnthropicError(res, 401, "authentication_error", "Invalid compact hook credential");
        return true;
      }
      try {
        const event = await readJsonBody<Record<string, unknown>>(req, 4 * 1024 * 1024);
        if (!event || typeof event.session_id !== "string") {
          writeAnthropicError(res, 400, "invalid_request_error", "Invalid compact event");
          return true;
        }
        if (event.hook_event_name === "PreCompact") {
          deps.compactionStore.recordPreCompact({
            sessionId: event.session_id,
            trigger: event.trigger === "manual" ? "manual" : "auto",
            customInstructions: typeof event.custom_instructions === "string" ? event.custom_instructions : "",
          });
        } else if (event.hook_event_name === "PostCompact") {
          deps.compactionStore.recordPostCompact({
            sessionId: event.session_id,
            summary: typeof event.compact_summary === "string" ? event.compact_summary : "",
          });
        } else {
          writeAnthropicError(res, 400, "invalid_request_error", "Unknown compact event");
          return true;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      } catch {
        writeAnthropicError(res, 400, "invalid_request_error", "Invalid compact event");
      }
      return true;
    }
    // 하네스의 gateway model discovery. 이게 있어야 Claude Code의 /model picker에 GPT가 뜬다.
    if (pathname.endsWith("/v1/models")) {
      if (!acceptedCredential(req.headers, harness)) {
        writeAnthropicError(res, 401, "authentication_error", "Missing Anthropic credential");
        return true;
      }
      res.writeHead(200, { "content-type": "application/json" });
      const settings = gatewaySettings();
      res.end(JSON.stringify(harness.buildModelList(
        settings ? resolveAiGatewaySelection(settings).models : GATEWAY_MODELS,
      )));
      return true;
    }
    if (!pathname.endsWith("/v1/messages")) return false;
    if (req.method !== "POST") {
      writeAnthropicError(res, 405, "invalid_request_error", "Method not allowed");
      return true;
    }
    const callerCredential = acceptedCredential(req.headers, harness);
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
    const target = harness.findModel(requested, GATEWAY_MODELS);
    if (!target && !harness.relaysUnmatchedModel(requested)) {
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

    const sessionId = claudeSessionId(body.metadata?.user_id);
    const compactSummary = target?.provider === "codex"
      && sessionId !== undefined
      && isClaudeCompactSummaryRequest(body.messages)
      ? deps.compactionStore?.readPending(sessionId)
      : undefined;
    if (compactSummary) body = { ...body, messages: stripClaudeCompactPrompt(body.messages) };

    // 대상을 가리지 않고 모든 요청에 닿아야 하는 다듬기는 하네스가 선언한다. 게이트웨이 대상이
    // 없는 네이티브 Anthropic까지 덮어야 하므로 아래 공급자 정책으로 내려갈 수 없다.
    body = harness.sanitizeRequest(body);
    // 하네스가 헤더로만 싣는 대화 정체성을, 업스트림이 읽는 자리로 옮겨 적는다.
    body = withSessionIdentity(body, harness, req.headers);
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
    } else if (target?.provider === "antigravity") {
      const antigravityToken = await deps.readAntigravityToken?.();
      if (!antigravityToken) {
        writeAnthropicError(res, 401, "authentication_error", "No active Antigravity sign-in was found. Run `agy` and sign in first.");
        return true;
      }
      credential = antigravityToken;
    }

    const controller = new AbortController();
    const abort = (): void => controller.abort(new Error("client disconnected"));
    req.once("close", abort);
    const startedAt = Date.now();

    try {
      if (!target) {
        // Native Anthropic models keep the caller-owned credential and wire request unchanged.
        await proxyToAnthropic(req.headers, res, body, fetchImpl, controller.signal, harness.retryableStatus);
        return true;
      }
      // Claude Code meters every custom model on either its unmarked 200k coordinate
      // or the truthful `[1m]` coordinate. Pass the real catalog window for both: the
      // compatibility seam removes only the capacity above Claude's chosen coordinate,
      // so each model reaches its real window minus Claude's own compaction reserve.
      const claudeContextWindow = target.contextWindow;
      const ceiling = compactCeiling();
      const projection = harness.usageProjection?.(ceiling);
      // 패스스루는 이미 인코딩된 본문을 다시 쓰므로 번역 경로와 다른 맵을 받는다. 둘 다
      // 하네스가 소유하고, 없으면 공급자 수치를 그대로 보낸다.
      const passthroughProjection = harness.passthroughProjection?.(ceiling);
      const passthroughRelay: PassthroughRelay = {
        ...(passthroughProjection ? { projectResponseBody: passthroughProjection } : {}),
        ...(harness.retryableStatus ? { retryableStatus: harness.retryableStatus } : {}),
      };
      if (target.provider === "kimi") {
        await proxyToKimi(
          req.headers,
          res,
          body,
          upstreamModelId(target),
          claudeContextWindow,
          passthroughRelay,
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
          passthroughRelay,
          credential,
          fetchImpl,
          controller.signal,
        );
        return true;
      }
      const codexAdapter = target.provider === "codex"
        ? new CodexResponsesAdapter({
            accountId: chatgptAccountId,
            headers: { originator: deps.originator },
            fetch: fetchImpl,
          })
        : undefined;
      const gateway = deps.gateway
        ?? (target.provider === "cursor"
          ? ownedCursorGateway!
          : target.provider === "opencode"
            ? createOpencodeGateway(
              opencodeGoWire(target) as "responses" | "chat-completions",
              fetchImpl,
            )
            : target.provider === "xai"
              ? new AnthropicMessagesGateway(new XaiResponsesAdapter({
                fetch: fetchImpl,
                endpoint: xaiEndpoint(),
              }))
              : target.provider === "antigravity"
                ? antigravityGateway()
                : new AnthropicMessagesGateway(codexAdapter!));
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
      const callOptions = {
        apiKey: credential,
        ...(claudeContextWindow ? { contextWindow: claudeContextWindow } : {}),
        ...(projection === undefined ? {} : { projectInputTokens: projection }),
        ...(harness.retryableStatus ? { retryableStatus: harness.retryableStatus } : {}),
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
      };

      if (compactSummary && codexAdapter && sessionId) {
        const binding = compactBinding(target.id, chatgptAccountId);
        const completedRetry = deps.compactionStore?.readReady(sessionId, binding);
        if (completedRetry) {
          writeClaudeCompactMessage(res, body, completedRetry.summary, {
            id: "msg_fleet_compact_retry",
            model: upstreamModelId(target),
            usage: null,
          });
          return true;
        }
        const canonical = translateAnthropicRequest(body, {
          model: upstreamModelId(target),
          ...(target.serviceTier ? { serviceTier: target.serviceTier } : {}),
          ...(target.effort.supported ? { reasoningEfforts: target.effort.levels } : {}),
          nativeTools: codexAdapter.capabilities.nativeTools,
        });
        let compactFlight = codexCompactionFlights.get(sessionId);
        if (!compactFlight) {
          compactFlight = compactCodexConversation({
            adapter: codexAdapter,
            request: canonical,
            call: {
              apiKey: credential,
              ...(modelContextWindow === undefined ? {} : { modelContextWindow }),
              signal: controller.signal,
            },
            customInstructions: compactSummary.customInstructions,
            supportedEfforts: target.effort.supported ? target.effort.levels : undefined,
          });
          codexCompactionFlights.set(sessionId, compactFlight);
          void compactFlight.finally(() => {
            if (codexCompactionFlights.get(sessionId) === compactFlight) {
              codexCompactionFlights.delete(sessionId);
            }
          }).catch(() => undefined);
        }
        const compacted = await compactFlight;
        if (compacted.encryptedContent) {
          deps.compactionStore?.writeReady(sessionId, {
            binding,
            encryptedContent: compacted.encryptedContent,
            summary: compacted.summary,
          });
        }
        // PostCompact is the authority that the client installed this response. Keep
        // pending until then so a transport retry is still classified as compaction.
        // PreCompact already invalidated any older ready checkpoint, so plaintext
        // fallback cannot accidentally replay stale provider state.
        writeClaudeCompactMessage(res, body, compacted.summary, compacted.summaryResponse);
        return true;
      }

      let upstream;
      if (target.provider === "codex" && sessionId && hasClaudeCompactContinuation(body.messages)) {
        const ready = deps.compactionStore?.readReady(sessionId, compactBinding(target.id, chatgptAccountId));
        if (ready) {
          body = { ...body, messages: stripClaudeCompactContinuation(body.messages) };
          const canonical = translateAnthropicRequest(body, {
            model: upstreamModelId(target),
            ...(target.serviceTier ? { serviceTier: target.serviceTier } : {}),
            ...(target.effort.supported ? { reasoningEfforts: target.effort.levels } : {}),
            nativeTools: codexAdapter?.capabilities.nativeTools,
          });
          canonical.input = [
            { type: "compaction", encrypted_content: ready.encryptedContent },
            ...canonical.input,
          ] as typeof canonical.input;
          upstream = await gateway.streamCanonical(body, canonical, callOptions);
        }
      }

      upstream ??= await gateway.stream(body, callOptions);
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
      // A transient gateway-side fault must arrive as a status Claude Code's retry budget acts
      // on. `502` is not one of them, so every dropped socket and stalled stream used to end the
      // turn at the client on the first try.
      const status = error instanceof ContextWindowExceededError
        ? 413
        : invalidRequest ? 400 : harness.transientErrorStatus;
      const message = errorMessage(error);
      const recordFailure = (): void => {
        if (!deps.failureJournal) return;
        const code = findCauseCode(error);
        const [busiest] = upstreamGate.stats()
          .slice()
          .sort((left, right) => right.inFlight - left.inFlight);
        deps.failureJournal({
          timestamp: new Date(startedAt).toISOString(),
          phase: res.headersSent ? "post_commit" : "pre_commit",
          ...(target ? { model: target.id, provider: target.provider } : {}),
          ...(res.headersSent ? {} : { status }),
          errorType: type,
          ...(code === undefined ? {} : { code }),
          detail: failureDetail(message),
          elapsedMs: Date.now() - startedAt,
          ...(busiest
            ? { upstreamInFlight: busiest.inFlight, upstreamQueued: busiest.queued }
            : {}),
        });
      };
      // 저널은 관측 수단일 뿐이므로, 호스트가 주입한 싱크가 던져도 클라이언트 응답을 막아서는
      // 안 된다. 가드가 없으면 싱크의 예외가 원래 실패를 덮고 이 catch 밖으로 빠져나가, 아래
      // 응답 종료가 실행되지 않는다.
      try {
        recordFailure();
      } catch {
        // 기록 실패는 삼킨다 — 기록하지 못한 것이 응답을 바꾸는 이유가 되면 안 된다.
      }
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
    upstreamStats: () => upstreamGate.stats(),
    dispose: () => {
      upstreamGate.dispose();
      codexCompactionFlights.clear();
      ownedCursorAdapter?.dispose();
    },
  };
}

/** Anthropic 모델은 번역하지 않는다. 요청 본문과 응답 스트림을 그대로 통과시킨다. */
async function proxyToAnthropic(
  requestHeaders: Record<string, unknown>,
  res: GatewayProxyResponse,
  body: AnthropicMessagesRequest,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  retryableStatus: ((status: number) => number) | undefined,
): Promise<void> {
  // 헤더·URL 정책은 core-ai-gateway가 소유한다. 여기는 요청을 실어 보낼 뿐이다.
  const headers = anthropicNativeHeaders(requestHeaders);
  await proxyAnthropicMessages(res, body, {
    ...(retryableStatus ? { retryableStatus } : {}),
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
  projection: PassthroughRelay,
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
    ...projection,
    responseModel,
    keepAlive: true,
    fetchImpl,
    headers,
    signal,
    url: KIMI_MESSAGES_URL,
    wireEventLabel: "kimi-anthropic.wire.event",
  });
}

/**
 * Anthropic Messages 와이어가 자격증명을 싣는 두 자리의 값을, 실린 순서대로 꺼낸다.
 *
 * 어떤 값을 인정할지는 하네스 프로필의 `acceptsCredential`이 정한다 — 이 함수는 헤더
 * 어휘만 안다. 둘 다 실려 있으면 둘 다 후보다: 인정되지 않는 bearer 뒤에 인정되는
 * x-api-key가 오는 요청을 예전 판정이 통과시켰고, 그 관대함을 유지한다. 게이트웨이는
 * 자체 bearer를 주입하지 않으므로, 고른 값은 Anthropic 원문 중계에서 청구 주체가 된다.
 */
/**
 * 하네스가 헤더에서만 읽을 수 있는 대화 정체성을 요청 본문의 자리로 옮겨 적는다.
 *
 * 업스트림은 캐논 요청의 `metadata.user_id` 하나만 본다 — Cursor는 그것으로 conversation과
 * x-session-id를 만들고, Codex는 sticky routing용 `session_id`를 만든다. 클라이언트가 그 값을
 * 어디에 싣는지는 클라이언트마다 다르므로 판독은 프로필이 하고, 이 함수는 옮겨 적기만 한다.
 *
 * 이미 값이 있으면 덮지 않는다. 본문에 직접 싣는 클라이언트(Claude Code)의 값이 언제나
 * 이기며, 그래야 기존 동작이 글자 하나 바뀌지 않는다.
 */
function claudeSessionId(rawUserId: unknown): string | undefined {
  if (typeof rawUserId !== "string" || rawUserId.trim().length === 0) return undefined;
  try {
    const parsed = JSON.parse(rawUserId) as { readonly session_id?: unknown };
    if (typeof parsed.session_id === "string" && parsed.session_id.trim().length > 0) {
      return parsed.session_id;
    }
  } catch {
    // Non-JSON clients may already use a stable session id directly.
  }
  return rawUserId;
}

function compactBinding(modelId: string, accountId: string): string {
  return createHash("sha256")
    .update("fleet:codex-compaction:v1:")
    .update(modelId)
    .update("\0")
    .update(accountId)
    .digest("hex");
}

function writeClaudeCompactMessage(
  res: GatewayProxyResponse,
  request: AnthropicMessagesRequest,
  summary: string,
  response: import("../canonical/index.js").CanonicalResponseSnapshot,
): void {
  const usage = {
    input_tokens: response.usage?.input_tokens ?? 0,
    cache_read_input_tokens: response.usage?.cached_input_tokens ?? 0,
    cache_creation_input_tokens: response.usage?.cache_write_input_tokens ?? 0,
    output_tokens: response.usage?.output_tokens ?? 0,
  };
  if (request.stream === true) {
    const frames = [
      ["message_start", {
        type: "message_start",
        message: {
          id: response.id,
          type: "message",
          role: "assistant",
          content: [],
          model: request.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { ...usage, output_tokens: 0 },
        },
      }],
      ["content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }],
      ["content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: summary },
      }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage,
      }],
      ["message_stop", { type: "message_stop" }],
    ] as const;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
    const encoder = new TextEncoder();
    for (const [event, data] of frames) {
      res.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    }
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: response.id,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: summary }],
    model: request.model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage,
  }));
}

function withSessionIdentity(
  body: AnthropicMessagesRequest,
  harness: GatewayHarnessProfile,
  headers: Readonly<Record<string, unknown>>,
): AnthropicMessagesRequest {
  const existing = body.metadata?.user_id;
  if (typeof existing === "string" && existing.trim().length > 0) return body;
  const identity = harness.resolveSessionIdentity?.(headers);
  if (!identity) return body;
  return { ...body, metadata: { ...body.metadata, user_id: identity } };
}

function callerWireCredentials(headers: Record<string, unknown>): readonly string[] {
  const candidates: string[] = [];
  const raw = headers.authorization;
  const bearer = typeof raw === "string" && /^bearer /i.test(raw) ? raw.slice(7).trim() : "";
  if (bearer.length > 0) candidates.push(bearer);
  const apiKey = typeof headers["x-api-key"] === "string" ? headers["x-api-key"].trim() : "";
  if (apiKey.length > 0) candidates.push(apiKey);
  return candidates;
}

/**
 * 호출자가 Claude Code 자신인지 판정한다.
 *
 * 라우터가 아니라 런타임 호스트(`ai-gateway-routes`)가 쓰는 공개 도우미다. Claude Code
 * 프로필의 자격증명 판정을 그대로 적용하므로, 라우터가 어느 하네스를 서빙하든 이 함수의
 * 답은 "Claude Code가 보낸 값인가"로 고정된다.
 */
export function callerAnthropicCredential(headers: Record<string, unknown>): string | null {
  return callerWireCredentials(headers)
    .find((credential) => claudeCodeHarnessProfile.acceptsCredential(credential)) ?? null;
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
