import type { QuotaSettingsHost } from "../../quota/host/storage.js";
import type { ServerOriginPort } from "@fleet-console/infra/http/host-ports";
import type { HttpSecurityPort } from "@fleet-console/infra/http/host-ports";
import type { HttpPort } from "@fleet-console/infra/http/host-ports";
import type { CleanupPort } from "@fleet-console/infra/http/host-ports";
import type { WorkspacePaths } from "../../workspace/host/path-port.js";
import type { ClaudeProcessSpawner } from "@fleet-console/agent-runtime/claude";
import path from "node:path";
import { readClaudeSupportedModels } from "@fleet-console/agent-runtime/claude";
import {
  DEFAULT_WIRE_LOG_MAX_BYTES,
  DEFAULT_WIRE_TOOL_INPUT_LOG_MAX_BYTES,
  createClaudeNativeModelSync,
  createQuotaLastGoodStore,
  createQuotaService,
  createMuseCodeOAuth,
  createCodexOAuth,
  createXaiOAuth,
  createAiGatewayQuotaCollectors,
  parseGatewayQuotaSnapshot,
  GATEWAY_PROVIDERS,
  GatewayRoutingDistribution,
  decideGatewayRoutingAssignment,
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
}
import { chooseRoutingModels } from "./routing-model.js";
import { registerAiGatewayRoutes } from "./routes.js";
import { registerTerminalModelAuthRoutes } from "./model-auth-routes.js";
import { registerConsoleOAuthRoutes } from "./oauth-routes.js";

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
  registerTerminalModelAuthRoutes(ctx, { authService });
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
  });
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
    const selection = resolveAiGatewaySelection(aiGatewayStore.read());
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
      antigravity: summary.providers.antigravity.status,
      "muse-code": summary.providers["muse-code"].status,
    };
  };
  function assign(request: unknown) {
      // 갱신은 비동기로, 배정은 같은 서비스의 현재 캐시를 즉시 읽는다.
      void quota.getSummary().catch(() => undefined);
      return decideGatewayRoutingAssignment(parseGatewayAssignmentRequest(request), currentExposure());
  }
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
          ...question, ...(signal ? { signal } : {}), judge: input.judge,
          baseUrl: `${ctx.host.server.origin()}${ctx.basePath}/ai-gateway`,
          directory: path.join(ctx.dataDir, "routing-model"), spawnProcess: ctx.spawnAgentProcess, readProviderStatuses,
        }),
        refreshExposure: currentExposure, signal: controller.signal,
      });
      if (!res.destroyed && !controller.signal.aborted) ctx.host.http.writeJson(res, 200, { decisions });
    } catch (error) {
      if (res.destroyed || controller.signal.aborted) return true;
      if (error instanceof NoEnabledGatewayModelsError) ctx.host.http.writeJson(res, 409, { error: "no_enabled_models" });
      else throw error;
    } finally { res.off("close", abort); }
    return true;
  }, [{ method: "POST", path: "", summary: "Route tasks with the caller's judge, then deterministic fallbacks.", category: "AI Gateway", gate: "origin-write", transport: "http" }]);
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
    assignRouting: async (request) => assign(request),
    readAuth: codex.readSubscription,
    readXaiToken: xai.readSubscriptionToken,
    readMuseCodeAuth: museCode.readAuth,
    renewMuseCodeAuth: museCode.renew,
    // 추론 스트림이 알려 준 Muse Code 사용량을 같은 사용량 캐시에 기록한다.
    observeMuseCodeUsage: (windows, apiKey) => { void museCode.observeUsage(windows, apiKey); },
  });
  return { store: aiGatewayStore, wireLog, runtime: aiGatewayRuntime, ensureClaudeNativeModels, onClaudeNativeModelsChanged, readProviderStatuses, subscribeProviderStatus, readCandidates, readEnabledModels };
}

function parseRoutingAssignRequest(body: unknown): { judge: { model: string; effort?: string }; items: { key: string; prompt: string }[] } | undefined {
  if (!body || typeof body !== "object") return undefined;
  const { judge, items } = body as { judge?: unknown; items?: unknown };
  if (!judge || typeof judge !== "object") return undefined;
  const { model, effort } = judge as { model?: unknown; effort?: unknown };
  if (typeof model !== "string" || !model.trim() || (effort !== undefined && typeof effort !== "string")) return undefined;
  if (!Array.isArray(items) || items.length < 1 || items.length > 20) return undefined;
  const seen = new Set<string>();
  let total = 0;
  const parsed: { key: string; prompt: string }[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") return undefined;
    const { key, prompt } = item as { key?: unknown; prompt?: unknown };
    if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(key) || seen.has(key)
      || typeof prompt !== "string" || !prompt.trim() || prompt.length > 16_384) return undefined;
    total += prompt.length;
    if (total > 131_072) return undefined;
    seen.add(key); parsed.push({ key, prompt });
  }
  return { judge: { model, ...(typeof effort === "string" ? { effort } : {}) }, items: parsed };
}
