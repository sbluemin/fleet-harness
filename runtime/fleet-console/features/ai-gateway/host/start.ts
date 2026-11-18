import type { QuotaSettingsHost } from "../../quota/host/storage.js";
import type { ServerOriginPort } from "@fleet-console/infra/http/host-ports";
import type { HttpSecurityPort } from "@fleet-console/infra/http/host-ports";
import type { HttpPort } from "@fleet-console/infra/http/host-ports";
import type { CleanupPort } from "@fleet-console/infra/http/host-ports";
import type { WorkspacePaths } from "../../workspace/host/path-port.js";
import type { ClaudeProcessSpawner } from "@fleet-console/agent-runtime/claude";
import { createExecutionAssignmentCache, type DelegationIntentLedger } from "@fleet-console/ai-gateway";
import path from "node:path";
import { readClaudeSupportedModels } from "@fleet-console/agent-runtime/claude";
import {
  DEFAULT_WIRE_LOG_MAX_BYTES,
  DEFAULT_WIRE_TOOL_INPUT_LOG_MAX_BYTES,
  createClaudeNativeModelSync,
  createQuotaLastGoodStore,
  createQuotaService,
  createAnthropicSpendLedger,
  createGeminiSpendLedger,
  createMuseCodeOAuth,
  createCodexOAuth,
  createXaiOAuth,
  createAiGatewayQuotaCollectors,
  parseGatewayQuotaSnapshot,
  GATEWAY_PROVIDERS,
  GatewayRoutingDistribution,
  decideGatewayRoutingAssignment,
  canRouteGatewayDelegation,
  type GatewayAssignmentRequest,
  buildGatewayCandidates,
  buildGatewayEnabledModels,
  decideGatewayRoutingBatch,
  NoEnabledGatewayModelsError,
  parseGatewayAssignmentRequest,
  resolveAiGatewaySelection,
  createAiGatewaySettingsStore,
  createProviderAuthService,
  defaultCredentialDeps,
  DEFAULT_ROSTER_SEED_MODEL_IDS,
  ANTHROPIC_AUTH_PROVIDER_ID,
  GEMINI_AUTH_PROVIDER_ID,
  OPENCODE_AUTH_PROVIDER_ID,
  setWireLogTarget,
  wireLogEnabled,
  type AiGatewayStoredSettings,
  type GatewayAssignmentExposure,
  type ProviderStatusMap,
} from "@fleet-console/ai-gateway";
import type { ApiCatalogEntry } from "@fleet-console/infra/http/catalog";
import type { RouteHandler } from "@fleet-console/infra/http/routing";
interface GatewayStartContext {
  readonly basePath: string;
  readonly dataDir: string;
  readonly host: {
    readonly paths: Pick<WorkspacePaths, "consoleDataDir" | "fleetDataDir">;
    readonly lifecycle: Pick<CleanupPort, "registerCleanup">;
    readonly http: Pick<HttpPort, "readJsonBody" | "writeJson">;
    readonly security: Pick<HttpSecurityPort, "isTerminalAuthorized">;
    readonly server: Pick<ServerOriginPort, "origin">;
    readonly storage: Pick<QuotaSettingsHost, "read">;
  };
  registerRouter(path: string, handler: RouteHandler, catalog?: ApiCatalogEntry | readonly ApiCatalogEntry[]): void;
  /**
   * The Claude Code executable Console launches. Claude alias entries resolve against this
   * installation; absent leaves them unresolved and native alias relays are refused.
   */
  readonly resolveClaudeExecutable?: () => Promise<string | undefined>;
  /** Console's owned-process port. The Claude CLI queried for supported models must be a child the Console's deadline ends. */
  readonly spawnAgentProcess: ClaudeProcessSpawner;
  /**
   * 위임 실행의 의도를 담아 두는 장부. 호출 전 판정(execution host)이 쓰고 이 게이트웨이가 읽는다.
   * 생략하면 가상 모델 id 요청은 구성 오류로 거절된다 — 선언 없이 기본 배정을 지어내지 않는다.
   */
  readonly delegationIntents?: DelegationIntentLedger;
}
import { chooseRoutingModels, parseRoutingAssignRequest, releaseAllRoutingSessions, releaseRoutingSession, routingObjectiveId } from "./routing-model.js";
import { registerAiGatewayRoutes } from "./routes.js";
import { registerTerminalModelAuthRoutes } from "./model-auth-routes.js";
import { registerConsoleOAuthRoutes } from "./oauth-routes.js";

/** 호출 전 판정과 첫 자식 요청 사이의 시한. 두 고지는 같은 밀리초대에 도착한다(0.3.322 실측). */
const EXECUTION_INTENT_TIMEOUT_MS = 1_500;
const EXECUTION_INTENT_TIMEOUT_MESSAGE = "Fleet could not match this delegated run to a dispatch, so it was not assigned a model.";

function applyWireLog(ctx: GatewayStartContext, stored: boolean | undefined): void {
  setWireLogTarget(stored === undefined
    ? undefined
    : stored
      ? {
        path: path.join(ctx.dataDir, "ai-gateway", "wire-log.jsonl"),
        maxBytes: DEFAULT_WIRE_LOG_MAX_BYTES,
        toolInputs: {
          path: path.join(ctx.dataDir, "ai-gateway", "wire-tool-inputs.jsonl"),
          maxBytes: DEFAULT_WIRE_TOOL_INPUT_LOG_MAX_BYTES,
        },
      }
      : null);
}

function createWireLogRuntime(ctx: GatewayStartContext) {
  return {
    enabled: wireLogEnabled,
    apply: (stored: boolean | undefined) => applyWireLog(ctx, stored),
  };
}

function applyStoredWireLog(ctx: GatewayStartContext, read: () => AiGatewayStoredSettings): void {
  try {
    applyWireLog(ctx, read().wireLogEnabled);
  } catch {
    // 손상된 설정은 환경변수의 로깅 대상을 비활성화한 채 기동한다.
    applyWireLog(ctx, false);
  }
}

export function startAiGateway(ctx: GatewayStartContext) {
  // 선별과 자격증명은 이 Console 인스턴스의 슬롯에 산다. 호스트는 자리와 옛 자리만 알려 주고,
  // 저장 형태·검증·승계 판단은 core-ai-gateway가 소유한다.
  const authService = createProviderAuthService({
    dataDir: ctx.host.paths.consoleDataDir,
    legacyDirs: [ctx.host.paths.fleetDataDir],
  });
  // Apply the stored target before registering routes so no request can observe an uninitialized mode.
  const aiGatewayStore = createAiGatewaySettingsStore({
    dataDir: ctx.host.paths.consoleDataDir,
    // 바로 앞 자리인 Fleet 루트에서만 한 번 승계한다.
    legacyDirs: [ctx.host.paths.fleetDataDir],
  });
  // 모델 로스터 일회 이행(표식으로 멱등) — 키 부재면 Claude 항목을 써 넣고, Claude 없는 비어 있지 않은 목록에는 더한다.
  // 빈 배열·Claude가 이미 있는 목록은 그대로 둔다. 승계(legacyDirs)를 먼저 마친 뒤 판단한다.
  try {
    aiGatewayStore.seedModels(DEFAULT_ROSTER_SEED_MODEL_IDS);
  } catch {
    // 잠금 경합·승계 미결은 결론이 아니다 — 이번 기동은 빈 로스터(sonnet 폴백)로 서고 다음 기동이 다시 시도한다.
  }
  const wireLog = createWireLogRuntime(ctx);
  applyStoredWireLog(ctx, aiGatewayStore.read);
  ctx.host.lifecycle.registerCleanup(() => setWireLogTarget(undefined));
  ctx.host.lifecycle.registerCleanup(() => releaseAllRoutingSessions());
  registerTerminalModelAuthRoutes(ctx, {
    authService,
    // OpenCode Go는 키 하나가 로그인이자 사용량 자격이다. 저장·삭제 직후 사용량을 다시 읽어야
    // 메뉴·배정이 캐시 수명(5분)을 기다리지 않고 새 로그인 상태를 본다.
    onChanged: (provider, signedIn) => {
      // Gemini 키도 같은 규칙이다 — 저장하면 그 공급자만 다시 읽어 메뉴 노출과 지출 카드가
      // 캐시 수명(5분)을 기다리지 않는다.
      if (provider === "gemini") {
        if (signedIn) void quota.getSummary({ forceProvider: "gemini" }).catch(() => undefined);
        else quota.record("gemini", { status: "signed_out" });
        return;
      }
      // Anthropic 키도 같은 규칙이다 — 저장·삭제 직후 메뉴 노출이 바뀐다.
      if (provider === "anthropic") {
        if (signedIn) void quota.getSummary({ forceProvider: "anthropic" }).catch(() => undefined);
        else quota.record("anthropic", { status: "signed_out" });
        return;
      }
      if (provider !== "opencode") return;
      if (signedIn) void quota.getSummary({ forceProvider: "opencode" }).catch(() => undefined);
      else quota.record("opencode", { status: "signed_out" });
    },
  });
  /**
   * 공급자별 누적 배정 수. 이 Console 프로세스가 소유한다.
   *
   * 고정 목록의 머리만 집으면 같은 등급의 팬아웃이 전원 한 모델로 몰린다. 세션마다 따로
   * 세면 동시에 뜬 세션들이 저마다 처음인 줄 알고 같은 공급자를 고르므로, 한 자리에서 센다.
   */
  const providerLoad = new Map<string, number>();
  const distribution = new GatewayRoutingDistribution();
  // 저장된 연결 동의는 유지하되 공급자 조회와 캐시는 Gateway 한 인스턴스가 소유한다.
  const isConnected = async (provider: "claude") => {
    const settings = await ctx.host.storage.read();
    return settings !== null && typeof settings === "object"
      && (settings as Record<string, unknown>)[`${provider}Connected`] === true;
  };
  const museCode = createMuseCodeOAuth({ authService, onQuota: (value) => quota.record("muse-code", value) });
  ctx.host.lifecycle.registerCleanup(() => museCode.dispose());
  registerConsoleOAuthRoutes(ctx, "muse-code", "Muse Code", museCode);
  // 추론과 quota가 같은 인스턴스를 써야 갱신이 한 번으로 묶인다.
  const codex = createCodexOAuth({ authService, cliCredentials: defaultCredentialDeps, onQuota: (value) => quota.record("codex", value) });
  ctx.host.lifecycle.registerCleanup(() => codex.dispose());
  registerConsoleOAuthRoutes(ctx, "codex", "Codex", codex);
  const xai = createXaiOAuth({ authService, cliCredentials: defaultCredentialDeps, onQuota: (value) => quota.record("xai", value) });
  ctx.host.lifecycle.registerCleanup(() => xai.dispose());
  registerConsoleOAuthRoutes(ctx, "xai", "xAI", xai);
  const providerStatusListeners = new Set<() => void>();
  // Gemini 지출 원장 — 응답 usageMetadata 토큰 × 확인 단가를 태평양시 달 경계로 누적하고,
  // 월 예산과 마지막 402·429를 같은 파일에 둔다. 값이 바뀌면 사용량 캐시를 만료시켜 다음 조회가
  // 새 값을 읽는다. 원장은 upstream을 모르고, 이 자리는 원장의 계산을 모른다.
  let expireGeminiQuota: (() => void) | undefined;
  const geminiLedger = createGeminiSpendLedger({
    filePath: path.join(ctx.host.paths.consoleDataDir, "ai-gateway", "gemini-spend.json"),
    onChange: () => expireGeminiQuota?.(),
  });
  // Anthropic 지출 원장 — 같은 달력 월(태평양시)로 응답 usage 토큰 × 단가를 누적하고, 월 예산·마지막 거절·
  // 마지막 한도 헤더를 싣는다. Gemini 원장과 같은 분업이고 같은 이유로 값이 바뀌면 사용량 캐시를 만료시킨다.
  let expireAnthropicQuota: (() => void) | undefined;
  const anthropicLedger = createAnthropicSpendLedger({
    filePath: path.join(ctx.host.paths.consoleDataDir, "ai-gateway", "anthropic-spend.json"),
    onChange: () => expireAnthropicQuota?.(),
  });
  const quota = createQuotaService({
    isClaudeConnected: () => isConnected("claude"),
    onProviderStatusChanged: () => {
      for (const listener of providerStatusListeners) listener();
    },
    ...createAiGatewayQuotaCollectors({ authService, museCode, codex, xai }),
    // 마지막 성공 사용량. Console 슬롯(격리 실행이면 격리 루트) 아래. 키·토큰은 넣지 않는다.
    lastGoodStore: createQuotaLastGoodStore({
      filePath: path.join(ctx.host.paths.consoleDataDir, "ai-gateway", "quota-last-good.json"),
    }),
    // Gemini는 조회할 upstream 사용량 API가 없다. 키가 저장돼 있는지만 보고, 지출·예산·차단은
    // 원장이 답한다 — 키가 없으면 미로그인(signed_out)이고 지출도 싣지 않는다.
    fetchGemini: async () => {
      const apiKey = await authService.getApiKey(GEMINI_AUTH_PROVIDER_ID);
      if (apiKey === undefined || apiKey.trim().length === 0) return { status: "signed_out" };
      const at = Date.now();
      const reading = geminiLedger.read(at);
      return {
        status: "ok",
        fetchedAt: at,
        spend: reading.spend,
        ...(reading.block !== undefined ? { block: reading.block } : {}),
      };
    },
    // Anthropic도 크레딧 잔액을 읽을 API가 없다(2026-11-18 실측: 워크스페이스 키 401, 조직 범위 키 403). 키가
    // 저장돼 있는지만 보고, 지출·예산·거절·분당 한도는 원장이 답한다 — 키가 없으면 미로그인(signed_out)이라
    // 모델 메뉴에서 빠지고 지출도 싣지 않는다.
    fetchAnthropic: async () => {
      const apiKey = await authService.getApiKey(ANTHROPIC_AUTH_PROVIDER_ID);
      if (apiKey === undefined || apiKey.trim().length === 0) return { status: "signed_out" };
      const at = Date.now();
      const reading = anthropicLedger.read(at);
      return {
        status: "ok",
        fetchedAt: at,
        spend: reading.spend,
        ...(reading.block !== undefined ? { block: reading.block } : {}),
        ...(reading.rateLimit !== undefined ? { rateLimit: reading.rateLimit } : {}),
      };
    },
  });
  expireGeminiQuota = () => quota.expire("gemini");
  expireAnthropicQuota = () => quota.expire("anthropic");
  // 월 예산 — Quota 패널의 카드가 지출 금액 옆에서 넣고 지운다. `usd: null`은 삭제다. 저장 자리는 원장과 같은
  // 파일이라 지출과 예산이 한 잠금 아래에서 함께 읽힌다. Gemini와 Anthropic이 같은 모양의 라우트를 쓴다.
  const registerSpendBudgetRoute = (
    route: string,
    label: string,
    ledger: { setBudget(value: unknown): boolean; clearBudget(): void },
  ): void => {
    ctx.registerRouter(route, async ({ req, res }) => {
      if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
      if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return true; }
      if (!req.headers["content-type"]?.includes("application/json")) { ctx.host.http.writeJson(res, 415, { error: "json_required" }); return true; }
      let body: unknown;
      try {
        body = await ctx.host.http.readJsonBody<unknown>(req);
      } catch {
        body = null;
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        ctx.host.http.writeJson(res, 400, { error: "invalid_budget_request" }); return true;
      }
      const fields = Object.keys(body);
      if (fields.length !== 1 || !("usd" in body)) {
        ctx.host.http.writeJson(res, 400, { error: "invalid_budget_request" }); return true;
      }
      const usd = (body as { readonly usd?: unknown }).usd;
      if (usd === null) {
        ledger.clearBudget();
      } else if (!ledger.setBudget(usd)) {
        ctx.host.http.writeJson(res, 400, { error: "invalid_budget" }); return true;
      }
      ctx.host.http.writeJson(res, 200, { ok: true });
      return true;
    }, [{ method: "POST", path: "", summary: `Set or clear the ${label} monthly spend budget.`, category: "AI Gateway", gate: "origin-write", transport: "http" }]);
  };
  registerSpendBudgetRoute("ai-gateway/quota/gemini-budget", "Gemini", geminiLedger);
  registerSpendBudgetRoute("ai-gateway/quota/anthropic-budget", "Anthropic", anthropicLedger);

  ctx.registerRouter("ai-gateway/quota", async ({ req, res }) => {
    if (req.method !== "GET") { ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return true; }
    const url = new URL(req.url ?? "/", "http://localhost");
    const provider = url.searchParams.get("forceProvider");
    if (provider !== null && !GATEWAY_PROVIDERS.includes(provider as typeof GATEWAY_PROVIDERS[number])) {
      ctx.host.http.writeJson(res, 400, { error: "invalid_provider" }); return true;
    }
    const force = url.searchParams.get("force") === "1";
    // `stale=1`: 만료된 캐시라도 먼저 돌려주고 갱신은 뒤에서 돈다. 명시적 새로고침은 기다리는 것이
    // 계약이라 force와 함께 오면 무시한다. `revalidating`은 이 응답에만 실린다 — 호출자가 HTTP 너머라
    // 캐시에서 나온 값인지 알 길이 이것뿐이고, 공유 DTO는 넓히지 않는다. 진행 중인 갱신에는 다음
    // 일반 요청이 single-flight로 합류한다.
    if (!force && provider === null && url.searchParams.get("stale") === "1") {
      const cached = quota.readCachedSummary();
      if (cached?.expired === true) {
        void quota.getSummary().catch(() => undefined);
        ctx.host.http.writeJson(res, 200, { ...cached.summary, revalidating: true });
        return true;
      }
    }
    const summary = await quota.getSummary({
      force,
      ...(provider === null ? {} : { forceProvider: provider as typeof GATEWAY_PROVIDERS[number] }),
    });
    ctx.host.http.writeJson(res, 200, summary);
    return true;
  }, [{ method: "GET", path: "", summary: "Read or explicitly refresh the shared Gateway quota cache.", category: "AI Gateway", gate: "origin-write", transport: "http" }]);
  function currentExposure(): GatewayAssignmentExposure {
    const settings = aiGatewayStore.read();
    const selection = resolveAiGatewaySelection(settings);
    const allowance = parseGatewayQuotaSnapshot(quota.peekSummary());
    return {
      delegationModels: selection.delegationModels,
      ...(selection.effortExposure === undefined ? {} : { effortExposure: selection.effortExposure }),
      ...(selection.providerPriority === undefined ? {} : { providerPriority: selection.providerPriority }),
      ...(allowance === undefined ? {} : { quota: allowance }),
      providerLoad,
      distribution,
    };
  }
  const readProviderStatuses = (): ProviderStatusMap | undefined => {
    const summary = quota.peekSummary();
    if (!summary) return undefined;
    return {
      claude: summary.providers.claude.status,
      codex: summary.providers.codex.status,
      xai: summary.providers.xai.status,
      "muse-code": summary.providers["muse-code"].status,
      opencode: summary.providers.opencode.status,
      // Gemini 키의 유무가 모델 메뉴와 설정의 로그인 표시를 가른다.
      gemini: summary.providers.gemini.status,
      // Anthropic 키의 유무가 크레딧 모델의 메뉴 노출을 가른다.
      anthropic: summary.providers.anthropic.status,
    } satisfies ProviderStatusMap;
  };
  function assign(request: unknown) {
      // 갱신은 비동기로, 배정은 같은 서비스의 현재 캐시를 즉시 읽는다.
      void quota.getSummary().catch(() => undefined);
      return decideGatewayRoutingAssignment(parseGatewayAssignmentRequest(request), currentExposure());
  }
  const canRouteDelegation = (request: GatewayAssignmentRequest): boolean => {
    void quota.getSummary().catch(() => undefined);
    return canRouteGatewayDelegation(request, currentExposure());
  };
  // 위임 실행의 가상 모델 id → 실제 배정. 실행 하나의 배정은 첫 요청에서 한 번만 정하고
  // 그 실행 id에 묶어 둔다 — 두 번째 요청이나 재시도에서 모델이 바뀌면 안 된다.
  const delegationIntents = ctx.delegationIntents;
  const executionAssignments = delegationIntents === undefined ? undefined : createExecutionAssignmentCache({
    resolve: async (request) => {
      const intent = await delegationIntents.awaitIntent(request.sessionId, request.agentId, EXECUTION_INTENT_TIMEOUT_MS);
      if (intent === undefined) return { error: EXECUTION_INTENT_TIMEOUT_MESSAGE };
      if (intent.sessionId !== request.sessionId) {
        return { error: "This delegated run does not match its dispatch session." };
      }
      void quota.getSummary().catch(() => undefined);
      const decision = decideGatewayRoutingAssignment(parseGatewayAssignmentRequest({
        surface: "agent",
        ...(intent.description === undefined ? {} : { description: intent.description }),
        ...(intent.requestedModel === undefined ? {} : { requestedModel: intent.requestedModel }),
        ...(intent.subagentType === undefined ? {} : { subagentType: intent.subagentType }),
      }), currentExposure());
      if (decision.model !== undefined) {
        return { modelId: decision.model, label: decision.label, because: decision.because };
      }
      // 후보가 없거나 모두 위험한 것은 오류가 아니라 정상 상속이다. 호출 시점의 세션 모델로 돌린다.
      if (intent.inheritModel === undefined || intent.inheritModel.length === 0) {
        return { error: "Fleet could not determine which model this delegated run should inherit." };
      }
      return { modelId: intent.inheritModel, label: decision.label, because: decision.because };
    },
  });
  const resolveExecutionModel = executionAssignments?.assign.bind(executionAssignments);
  const releaseExecutionSession = (sessionId: string): void => {
    executionAssignments?.releaseSession(sessionId);
    delegationIntents?.releaseSession(sessionId);
  };
  /** 설정 카드의 코드 규칙 후보. 갱신은 비동기로, 응답은 현재 캐시로 낸다. */
  const readCandidates = () => {
    void quota.getSummary().catch(() => undefined);
    return buildGatewayCandidates(currentExposure());
  };
  ctx.registerRouter("ai-gateway/candidates", async ({ req, res }) => {
    if (req.method !== "GET") { ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return true; }
    ctx.host.http.writeJson(res, 200, readCandidates());
    return true;
  }, [{ method: "GET", path: "", summary: "Read eligible candidate models ordered by quota headroom.", category: "AI Gateway", gate: "origin-write", transport: "http" }]);
  /** `enabled-models` 라우트와 `fleet-ai-gateway` models 도구가 같은 본문을 읽는다. 로그인 상태가 목록을 가르므로 갱신도 같이 건다. */
  const readEnabledModels = () => {
    void quota.getSummary().catch(() => undefined);
    return buildGatewayEnabledModels(currentExposure());
  };
  ctx.registerRouter("ai-gateway/enabled-models", async ({ req, res }) => {
    if (req.method !== "GET") { ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return true; }
    ctx.host.http.writeJson(res, 200, readEnabledModels());
    return true;
  }, [{ method: "GET", path: "", summary: "Read enabled models in settings order, without quota pressure.", category: "AI Gateway", gate: "origin-write", transport: "http" }]);
  ctx.registerRouter("ai-gateway/routing-assign", async ({ req, res }) => {
    if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return true; }
    if (!req.headers["content-type"]?.includes("application/json")) { ctx.host.http.writeJson(res, 415, { error: "json_required" }); return true; }
    const input = parseRoutingAssignRequest(await ctx.host.http.readJsonBody<unknown>(req));
    if (!input) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return true; }
    void quota.getSummary().catch(() => undefined);
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.once("close", abort);
    try {
      const decisions = await decideGatewayRoutingBatch(input.items, currentExposure(), {
        choose: (question, signal) => chooseRoutingModels({
          ...question, ...(signal ? { signal } : {}), objectiveId: input.objectiveId, judge: input.judge,
          baseUrl: `${ctx.host.server.origin()}${ctx.basePath}/ai-gateway`,
          spawnProcess: ctx.spawnAgentProcess, readProviderStatuses,
          ...(ctx.resolveClaudeExecutable ? { resolveExecutable: ctx.resolveClaudeExecutable } : {}),
        }),
        ...(input.commander ? { commanderAssignment: input.commander } : {}),
        refreshExposure: currentExposure, signal: controller.signal,
      });
      if (!res.destroyed && !controller.signal.aborted) ctx.host.http.writeJson(res, 200, { decisions });
    } catch (error) {
      if (res.destroyed || controller.signal.aborted) return true;
      if (error instanceof NoEnabledGatewayModelsError) ctx.host.http.writeJson(res, 409, { error: "no_enabled_models" });
      else throw error;
    } finally { res.off("close", abort); }
    return true;
  }, [{ method: "POST", path: "", summary: "Route tasks with the commodore judge, then deterministic fallbacks.", category: "AI Gateway", gate: "origin-write", transport: "http" }]);
  ctx.registerRouter("ai-gateway/routing-session/dispose", async ({ req, res }) => {
    if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return true; }
    if (!req.headers["content-type"]?.includes("application/json")) { ctx.host.http.writeJson(res, 415, { error: "json_required" }); return true; }
    const body = await ctx.host.http.readJsonBody<unknown>(req);
    const objectiveId = routingObjectiveId(body && typeof body === "object" ? (body as { objectiveId?: unknown }).objectiveId : undefined);
    if (!objectiveId) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return true; }
    await releaseRoutingSession(objectiveId);
    if (!res.destroyed) ctx.host.http.writeJson(res, 200, { ok: true });
    return true;
  }, [{ method: "POST", path: "", summary: "Discard one objective's routing judgment session.", category: "AI Gateway", gate: "origin-write", transport: "http" }]);
  const resolveClaudeExecutable = ctx.resolveClaudeExecutable;
  // Claude alias가 가리키는 버전은 Console이 띄우는 그 CLI가 정한다. 필요한 순간에만 묻는다.
  const claudeNativeListeners = new Set<() => void>();
  const claudeNativeModels = resolveClaudeExecutable
    ? createClaudeNativeModelSync({
      resolveExecutable: resolveClaudeExecutable,
      // 질의 자식도 Console 소유 그룹에서 띄운다 — Console이 끝나면 함께 끝난다.
      readSupportedModels: (executable) => readClaudeSupportedModels({ ...(executable === undefined ? {} : { executablePath: executable }), spawnProcess: ctx.spawnAgentProcess }),
      onChanged: () => { for (const listener of claudeNativeListeners) listener(); },
    })
    : undefined;
  /** CLI가 알려 준 Claude 별칭 표로 카탈로그가 바뀐 직후 울린다. */
  const onClaudeNativeModelsChanged = (listener: () => void): (() => void) => {
    claudeNativeListeners.add(listener);
    return () => { claudeNativeListeners.delete(listener); };
  };
  const ensureClaudeNativeModels = claudeNativeModels?.ensure;
  const subscribeProviderStatus = (listener: () => void): (() => void) => {
    providerStatusListeners.add(listener);
    // 구독보다 먼저 끝난 기동 조회를 놓치지 않는다. 아직 캐시가 없으면 조회가 끝나는 알림이 이어 부른다.
    if (quota.peekSummary()) listener();
    return () => { providerStatusListeners.delete(listener); };
  };
  // 대화 화면이 쿼터를 부르기 전에는 로그인 상태가 비어 메뉴가 전체 카탈로그로 열린다.
  // 자격 확인은 조회 함수가 로컬에서 끝내고, 로그인이 있을 때만 사용량 호출로 이어진다.
  void quota.getSummary().catch(() => undefined);
  const aiGatewayRuntime = registerAiGatewayRoutes(ctx, {
    ...(ensureClaudeNativeModels ? { ensureClaudeNativeModels } : {}),
    readAiGatewaySettings: aiGatewayStore.read,
    readProviderStatuses,
    ...(resolveExecutionModel === undefined ? {} : { resolveExecutionModel }),
    readAuth: codex.readSubscription,
    readXaiToken: xai.readSubscriptionToken,
    readMuseCodeAuth: museCode.readAuth,
    renewMuseCodeAuth: museCode.renew,
    readOpencodeApiKey: () => authService.getApiKey(OPENCODE_AUTH_PROVIDER_ID),
    readGeminiApiKey: () => authService.getApiKey(GEMINI_AUTH_PROVIDER_ID),
    readAnthropicApiKey: () => authService.getApiKey(ANTHROPIC_AUTH_PROVIDER_ID),
    // Anthropic 턴이 끝나거나 크레딧·한도로 거절될 때, 그리고 응답 헤더를 볼 때마다 부르는 지출 원장.
    anthropicUsage: anthropicLedger,
    // Gemini 턴이 끝나거나 402·429로 거절될 때 업스트림이 부르는 지출 원장.
    geminiUsage: geminiLedger,
    // 추론 스트림이 알려 준 Muse Code 사용량을 같은 사용량 캐시에 기록한다.
    observeMuseCodeUsage: (windows, apiKey) => { void museCode.observeUsage(windows, apiKey); },
  });
  return {
    store: aiGatewayStore,
    wireLog,
    runtime: aiGatewayRuntime,
    ensureClaudeNativeModels,
    onClaudeNativeModelsChanged,
    readProviderStatuses,
    subscribeProviderStatus,
    readCandidates,
    readEnabledModels,
    canRouteDelegation,
    // SDK 세션이 접힐 때 그 세션의 위임 배정을 걷는다. 실행 host의 dispose가 이 자리를 부른다.
    releaseExecutionSession,
  };
}

