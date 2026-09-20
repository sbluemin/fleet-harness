import path from "node:path";
import { DEFAULT_WIRE_LOG_MAX_BYTES, decideGatewayRoutingAssignment, parseGatewayAssignmentRequest, resolveAiGatewaySelection, createAiGatewaySettingsStore, createProviderAuthService, setWireLogTarget, wireLogEnabled, KIMI_AUTH_PROVIDER_ID, OPENCODE_AUTH_PROVIDER_ID, type AiGatewayStoredSettings, type GatewayQuotaSnapshot } from "@fleet-console/ai-gateway";
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
  const aiGatewayRuntime = registerAiGatewayRoutes(ctx, {
    readAiGatewaySettings: aiGatewayStore.read,
    // 위임 하나를 무엇으로 보낼지 Console이 판정한다. 호출 시점의 노출을 읽으므로 세션
    // 중에 모델을 켜고 끄면 다음 위임부터 반영된다 — 정체성을 등록하던 시절에는 이 값이
    // 세션 시작에 고정돼, 설정을 바꿔도 CLI를 다시 띄우기 전에는 먹지 않았다.
    assignRouting: (request) => {
      refreshAllowanceSoon();
      const selection = resolveAiGatewaySelection(aiGatewayStore.read());
      return decideGatewayRoutingAssignment(parseGatewayAssignmentRequest(request), {
        delegationRoutingEnabled: selection.delegationRoutingEnabled,
        delegationModels: selection.delegationModels,
        ...(selection.effortExposure === undefined ? {} : { effortExposure: selection.effortExposure }),
        ...(selection.providerPriority === undefined ? {} : { providerPriority: selection.providerPriority }),
        ...(allowance === undefined ? {} : { quota: allowance }),
        providerLoad,
      });
    },
    readKimiApiKey: () => authService.getApiKey(KIMI_AUTH_PROVIDER_ID),
    readOpencodeApiKey: () => authService.getApiKey(OPENCODE_AUTH_PROVIDER_ID),
  });
  return { store: aiGatewayStore, wireLog, runtime: aiGatewayRuntime };
}
