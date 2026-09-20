import path from "node:path";
import { DEFAULT_WIRE_LOG_MAX_BYTES, DISABLED_GATEWAY_ROUTING_TABLE, buildGatewayRoutingTable, resolveAiGatewaySelection, createAiGatewaySettingsStore, createProviderAuthService, setWireLogTarget, wireLogEnabled, KIMI_AUTH_PROVIDER_ID, OPENCODE_AUTH_PROVIDER_ID, type AiGatewayStoredSettings } from "@fleet-console/ai-gateway";
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
  const aiGatewayRuntime = registerAiGatewayRoutes(ctx, {
    readAiGatewaySettings: aiGatewayStore.read,
    // 호출 시점의 노출을 읽어 라우팅 표를 만든다. 세션 중에 모델을 켜고 끄면 다음 위임부터
    // 반영된다 — 정체성을 등록하던 시절에는 이 값이 세션 시작에 고정돼, 설정을 바꿔도
    // CLI를 다시 띄우기 전에는 먹지 않았다.
    readRoutingTable: () => {
      const selection = resolveAiGatewaySelection(aiGatewayStore.read());
      // 끈 세션은 빈 표를 받는다. 조회는 배정마다 일어나므로 토글은 다음 위임부터 먹는다.
      if (!selection.delegationRoutingEnabled) return DISABLED_GATEWAY_ROUTING_TABLE;
      return buildGatewayRoutingTable(selection.delegationModels, {
        effortExposure: selection.effortExposure,
        ...(selection.providerPriority ? { providerPriority: selection.providerPriority } : {}),
      });
    },
    readKimiApiKey: () => authService.getApiKey(KIMI_AUTH_PROVIDER_ID),
    readOpencodeApiKey: () => authService.getApiKey(OPENCODE_AUTH_PROVIDER_ID),
  });
  return { store: aiGatewayStore, wireLog, runtime: aiGatewayRuntime };
}
