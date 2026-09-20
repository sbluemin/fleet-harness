import path from "node:path";
import { chooseRoutingModel } from "./routing-model.js";
import {
  DEFAULT_WIRE_LOG_MAX_BYTES,
  decideGatewayRoutingAssignment,
  JEV_ROUTING_TIMEOUT_MS,
  parseGatewayAssignmentRequest,
  resolveAiGatewaySelection,
  createAiGatewaySettingsStore,
  createProviderAuthService,
  setWireLogTarget,
  wireLogEnabled,
  KIMI_AUTH_PROVIDER_ID,
  OPENCODE_AUTH_PROVIDER_ID,
  SystemOneClient,
  TYPESAFE_AUTH_PROVIDER_ID,
  type AiGatewayStoredSettings,
  type GatewayAssignmentExposure,
  type GatewayQuotaSnapshot,
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
  };
  registerRouter(path: string, handler: RouteHandler, catalog?: ApiCatalogEntry | readonly ApiCatalogEntry[]): void;
}
import { readConsoleQuotaSnapshot } from "./gateway-loadout.js";
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
  /**
   * 마지막으로 읽은 허용량. 배정은 **이 값을 기다리지 않는다.**
   *
   * 요약은 네 공급자를 모두 기다린 뒤 답하고 최악 대기가 20초를 넘는다. 그 조회를 배정
   * 경로에 넣으면 위임 하나가 그만큼 멈춘다. 그래서 배정은 지금 손에 있는 값으로 결정하고
   * 갱신은 뒤에서 돌린다 — 첫 배정 한 번이 허용량 없이 도는 대신, 어느 배정도 멈추지 않는다.
   */
  let allowance: GatewayQuotaSnapshot | undefined;
  let allowanceReadAt = 0;
  let allowanceInFlight = false;
  const ALLOWANCE_TTL_MS = 60_000;
  function refreshAllowanceSoon(): void {
    if (allowanceInFlight || Date.now() - allowanceReadAt < ALLOWANCE_TTL_MS) return;
    allowanceInFlight = true;
    void readConsoleQuotaSnapshot(ctx.host.server.origin())
      .then((snapshot) => { allowance = snapshot; })
      // 실패해도 읽은 시각은 찍는다. 아니면 배정마다 같은 실패를 다시 두드린다.
      .catch(() => undefined)
      .finally(() => { allowanceReadAt = Date.now(); allowanceInFlight = false; });
  }
  function currentExposure(): GatewayAssignmentExposure {
    const selection = resolveAiGatewaySelection(aiGatewayStore.read());
    return {
      delegationRoutingEnabled: selection.delegationRoutingEnabled,
      delegationRoutingMode: selection.delegationRoutingMode,
      delegationModels: selection.delegationModels,
      ...(selection.effortExposure === undefined ? {} : { effortExposure: selection.effortExposure }),
      ...(selection.providerPriority === undefined ? {} : { providerPriority: selection.providerPriority }),
      ...(allowance === undefined ? {} : { quota: allowance }),
      providerLoad,
    };
  }
  // 배정 경로 전용. 기본 30s·3재시도를 그대로 쓰면 spawn이 멈춘다.
  const jevClient = new SystemOneClient({
    readApiKey: () => authService.getApiKey(TYPESAFE_AUTH_PROVIDER_ID),
    timeoutMs: JEV_ROUTING_TIMEOUT_MS,
    maxAttempts: 1,
  });
  async function assign(request: unknown, signal?: AbortSignal, test = false) {
      refreshAllowanceSoon();
      const parsed = parseGatewayAssignmentRequest(request);
      const exposure = test ? { ...currentExposure(), providerLoad: new Map(providerLoad) } : currentExposure();
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
        refreshExposure: () => test ? { ...currentExposure(), providerLoad: exposure.providerLoad } : currentExposure(),
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
    } catch {
      if (!res.destroyed) ctx.host.http.writeJson(res, 502, { error: "routing_test_failed" });
    } finally { testing = false; res.off("close", abort); }
    return true;
  }, [{ method: "POST", path: "", summary: "Test the configured routing decision with a real provider request.", category: "Console Execution", gate: "origin-write", transport: "http" }]);
  const aiGatewayRuntime = registerAiGatewayRoutes(ctx, {
    readAiGatewaySettings: aiGatewayStore.read,
    assignRouting: (request, options) => assign(request, options?.signal),
    readKimiApiKey: () => authService.getApiKey(KIMI_AUTH_PROVIDER_ID),
    readOpencodeApiKey: () => authService.getApiKey(OPENCODE_AUTH_PROVIDER_ID),
  });
  return { store: aiGatewayStore, wireLog, runtime: aiGatewayRuntime };
}
