import path from "node:path";
import { chooseRoutingModel } from "./routing-model.js";
import {
  DEFAULT_WIRE_LOG_MAX_BYTES,
  createQuotaService,
  createAiGatewayQuotaCollectors,
  parseGatewayQuotaSnapshot,
  GATEWAY_PROVIDERS,
  GatewayRoutingDistribution,
  findGatewayModel,
  isLegacyCursorModelId,
  LegacyGatewayModelSelectionError,
  decideGatewayRoutingAssignment,
  JEV_ROUTING_TIMEOUT_MS,
  parseGatewayAssignmentRequest,
  resolveAiGatewaySelection,
  createAiGatewaySettingsStore,
  createProviderAuthService,
  setWireLogTarget,
  wireLogEnabled,
  OPENCODE_AUTH_PROVIDER_ID,
  SystemOneClient,
  TYPESAFE_AUTH_PROVIDER_ID,
  type AiGatewayStoredSettings,
  type GatewayAssignmentExposure,
} from "@fleet-console/ai-gateway";
import type { ApiCatalogEntry, FleetPluginHostCapabilities } from "@fleet-console/sdk/plugin";
import type { RouteHandler } from "@fleet-console/sdk/routing";
interface GatewayStartContext {
  readonly basePath: string;
  readonly dataDir: string;
  readonly legacyDataDir: string;
  readonly host: {
    readonly paths: Pick<FleetPluginHostCapabilities["paths"], "consoleDataDir" | "fleetDataDir">;
    readonly lifecycle: Pick<FleetPluginHostCapabilities["lifecycle"], "registerCleanup">;
    readonly http: Pick<FleetPluginHostCapabilities["http"], "readJsonBody" | "writeJson">;
    readonly security: Pick<FleetPluginHostCapabilities["security"], "isTerminalAuthorized">;
    readonly server: Pick<FleetPluginHostCapabilities["server"], "origin">;
    readonly storage: Pick<FleetPluginHostCapabilities["storage"], "readJson">;
  };
  registerRouter(path: string, handler: RouteHandler, catalog?: ApiCatalogEntry | readonly ApiCatalogEntry[]): void;
}
import { registerAiGatewayRoutes } from "./routes.js";
import { registerTerminalModelAuthRoutes } from "./model-auth-routes.js";

function applyWireLog(ctx: GatewayStartContext, stored: boolean | undefined): void {
  setWireLogTarget(stored === undefined
    ? undefined
    : stored
      ? {
        path: path.join(ctx.dataDir, "ai-gateway", "wire-log.jsonl"),
        maxBytes: DEFAULT_WIRE_LOG_MAX_BYTES,
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
    // 가장 최근 자리(Fleet 루트)를 앞에, 그 이전의 플러그인 데이터 슬롯을 뒤에 둔다.
    legacyDirs: [ctx.host.paths.fleetDataDir, ctx.legacyDataDir],
  });
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
  const isClaudeConnected = async () => {
    const settings = await ctx.host.storage.readJson("quota", "settings");
    return settings !== null && typeof settings === "object"
      && (settings as Record<string, unknown>).claudeConnected === true;
  };
  const quota = createQuotaService({
    isClaudeConnected,
    ...createAiGatewayQuotaCollectors({ authService }),
  });
  ctx.registerRouter("ai-gateway/quota", async ({ req, res }) => {
    if (req.method !== "GET") { ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return true; }
    const url = new URL(req.url ?? "/", "http://localhost");
    const provider = url.searchParams.get("forceProvider");
    if (provider !== null && !GATEWAY_PROVIDERS.includes(provider as typeof GATEWAY_PROVIDERS[number])) {
      ctx.host.http.writeJson(res, 400, { error: "invalid_provider" }); return true;
    }
    const summary = await quota.getSummary({
      force: url.searchParams.get("force") === "1",
      ...(provider === null ? {} : { forceProvider: provider as typeof GATEWAY_PROVIDERS[number] }),
    });
    ctx.host.http.writeJson(res, 200, summary);
    return true;
  }, [{ method: "GET", path: "", summary: "Read or explicitly refresh the shared Gateway quota cache.", category: "AI Gateway", gate: "origin-write", transport: "http" }]);
  function currentExposure(): GatewayAssignmentExposure {
    const selection = resolveAiGatewaySelection(aiGatewayStore.read());
    const allowance = parseGatewayQuotaSnapshot(quota.peekSummary());
    return {
      delegationRoutingEnabled: selection.delegationRoutingEnabled,
      delegationRoutingMode: selection.delegationRoutingMode,
      delegationModels: selection.delegationModels,
      ...(selection.effortExposure === undefined ? {} : { effortExposure: selection.effortExposure }),
      ...(selection.providerPriority === undefined ? {} : { providerPriority: selection.providerPriority }),
      ...(allowance === undefined ? {} : { quota: allowance }),
      providerLoad,
      distribution,
    };
  }
  // 배정 경로 전용. 기본 30s·3재시도를 그대로 쓰면 spawn이 멈춘다.
  const jevClient = new SystemOneClient({
    readApiKey: () => authService.getApiKey(TYPESAFE_AUTH_PROVIDER_ID),
    timeoutMs: JEV_ROUTING_TIMEOUT_MS,
    maxAttempts: 1,
  });
  async function assign(request: unknown, signal?: AbortSignal, test = false) {
      // 갱신은 비동기로, 배정은 같은 서비스의 현재 캐시를 즉시 읽는다.
      void quota.getSummary().catch(() => undefined);
      const parsed = parseGatewayAssignmentRequest(request);
      const settings = aiGatewayStore.read();
      const exposure = test ? { ...currentExposure(), providerLoad: new Map(providerLoad), distribution: new GatewayRoutingDistribution() } : currentExposure();
      if (exposure.delegationRoutingEnabled && exposure.delegationRoutingMode === "model"
        && settings.delegationRoutingModel && isLegacyCursorModelId(settings.delegationRoutingModel)
        && !findGatewayModel(settings.delegationRoutingModel)) {
        throw new LegacyGatewayModelSelectionError();
      }
      return await decideGatewayRoutingAssignment(parsed, exposure, {
        ...(exposure.delegationRoutingMode === "model" ? {
          choose: (input, signal) => chooseRoutingModel({
            ...input, signal,
            settings: aiGatewayStore.read(),
            baseUrl: `${ctx.host.server.origin()}${ctx.basePath}/ai-gateway`,
            directory: path.join(ctx.dataDir, "routing-model"),
          }),
        } : { client: jevClient }),
        forceDecision: test,
        refreshExposure: () => test ? { ...currentExposure(), providerLoad: exposure.providerLoad, distribution: exposure.distribution } : currentExposure(),
        ...(signal === undefined ? {} : { signal }),
      });
  }
  let testing = false;
  ctx.registerRouter("ai-gateway/routing-test", async ({ req, res }) => {
    if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return true; }
    if (!req.headers["content-type"]?.includes("application/json")) { ctx.host.http.writeJson(res, 415, { error: "json_required" }); return true; }
    if (testing) { ctx.host.http.writeJson(res, 409, { error: "routing_test_in_progress" }); return true; }
    const body = await ctx.host.http.readJsonBody<{ prompt?: unknown }>(req);
    if (typeof body?.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 65536) {
      ctx.host.http.writeJson(res, 400, { error: "invalid_prompt" }); return true;
    }
    const selection = currentExposure();
    if (!selection.delegationRoutingEnabled || !selection.delegationModels.length) {
      ctx.host.http.writeJson(res, 409, { error: "routing_disabled_or_no_candidates" }); return true;
    }
    if (testing) { ctx.host.http.writeJson(res, 409, { error: "routing_test_in_progress" }); return true; }
    testing = true;
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.once("close", abort);
    const started = Date.now();
    try {
      const decision = await assign({ surface: "agent", prompt: body.prompt, providerPlugin: "engine" }, controller.signal, true);
      if (!res.destroyed) ctx.host.http.writeJson(res, 200, {
        mode: selection.delegationRoutingMode, elapsedMs: Date.now() - started,
        ...decision, fallback: decision.because.includes("fallback"),
      });
    } catch (error) {
      if (!res.destroyed) ctx.host.http.writeJson(res, error instanceof LegacyGatewayModelSelectionError ? 409 : 502,
        { error: error instanceof LegacyGatewayModelSelectionError ? "gateway_model_reselection_required" : "routing_test_failed" });
    } finally { testing = false; res.off("close", abort); }
    return true;
  }, [{ method: "POST", path: "", summary: "Test the configured routing decision with a real provider request.", category: "Console Execution", gate: "origin-write", transport: "http" }]);
  const aiGatewayRuntime = registerAiGatewayRoutes(ctx, {
    readAiGatewaySettings: aiGatewayStore.read,
    assignRouting: (request, options) => assign(request, options?.signal),
    readOpencodeApiKey: () => authService.getApiKey(OPENCODE_AUTH_PROVIDER_ID),
  });
  return { store: aiGatewayStore, wireLog, runtime: aiGatewayRuntime };
}
