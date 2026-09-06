import path from "node:path";

/** Console이 제어 보유자 변화를 알리는 채널. 이름은 core/host/access-control-contract.ts와 한 벌이다. */
const CONTROL_HOLDER_EVENT_CHANNEL = "control:holder";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { definePlugin, registerLaunchCatalog, registerWsHandler } from "@fleet-console/sdk/plugin/node";
import { createInfraServices } from "@dotobokuri/core-infra";
import { KIMI_AUTH_PROVIDER_ID, OPENCODE_AUTH_PROVIDER_ID } from "@dotobokuri/fleet-admiral";
import {
  DEFAULT_WIRE_LOG_MAX_BYTES,
  createAiGatewaySettingsStore,
  createProviderAuthService,
  setWireLogTarget,
  wireLogEnabled,
} from "@dotobokuri/core-ai-gateway";
import type { AiGatewayStoredSettings } from "@dotobokuri/core-ai-gateway";

import { registerAgentRoutes } from "./server/agent.js";
import { registerAnalysisRoutes } from "./server/agent-api/analysis-routes.js";
import { registerExperimentRoutes } from "./server/agent-api/experiments-routes.js";
import { AI_GATEWAY_ROUTE_SEGMENT, registerAiGatewayRoutes } from "./server/ai-gateway-routes.js";
import { createAgentCliPathStore } from "./server/agent-api/agent-cli-paths.js";
import { registerTerminalSettingsRoutes } from "./server/settings-routes.js";
import { registerTerminalModelAuthRoutes } from "./server/model-auth-routes.js";
import { createTerminalRuntime } from "./server/shared/index.js";
import { registerShellRoutes } from "./server/shell.js";

function applyWireLog(ctx: FleetPluginServerContext, stored: boolean | undefined): void {
  setWireLogTarget(stored === undefined
    ? undefined
    : stored
      ? {
        path: path.join(ctx.host.paths.pluginDataDir(ctx.pluginId), "ai-gateway", "wire-log.jsonl"),
        maxBytes: DEFAULT_WIRE_LOG_MAX_BYTES,
      }
      : null);
}

function createWireLogRuntime(ctx: FleetPluginServerContext) {
  return {
    enabled: wireLogEnabled,
    apply: (stored: boolean | undefined) => applyWireLog(ctx, stored),
  };
}

function applyStoredWireLog(ctx: FleetPluginServerContext, read: () => AiGatewayStoredSettings): void {
  try {
    applyWireLog(ctx, read().wireLogEnabled);
  } catch {
    // Malformed durable settings must not prevent the built-in plugin from starting;
    // fail closed by overriding any env target until a valid setting is available.
    applyWireLog(ctx, false);
  }
}

const TERMINAL_PLUGIN_ID = "terminal";
const TERMINAL_SENSITIVE_FIELDS = ["cwd", "canonicalCwd", "providerTitle", "transcriptPath", "token", "ticket", "prompt", "persona", "toolAllowlist"] as const;
const OPERATION_DELETED_EVENT_CHANNEL = "operation:deleted";

export default definePlugin({
  id: TERMINAL_PLUGIN_ID,
  name: "Terminal",
  async register(ctx) {
    ctx.host.operations.registerOperationType("agent");
    ctx.host.operations.registerPayloadSanitizer(ctx.pluginId, TERMINAL_SENSITIVE_FIELDS);
    const infraServices = createInfraServices();
    const authService = createProviderAuthService({ dataDir: ctx.host.paths.fleetDataDir });
    const runtime = createTerminalRuntime(ctx);
    registerWsHandler(ctx, "/", runtime.handleUpgrade, { method: "GET", path: "", summary: "Open the Terminal WebSocket transport.", category: "Terminal Plugin", gate: "one-use-ticket", transport: "websocket" });
    ctx.host.lifecycle.registerCleanup(() => runtime.stop());
    const unsubscribeDelete = ctx.host.events.subscribe(OPERATION_DELETED_EVENT_CHANNEL, (payload) => {
      if (!isOperationDeletedEvent(payload) || payload.pluginId !== ctx.pluginId) return;
      runtime.terminate(payload.operationId);
    });
    ctx.host.lifecycle.registerCleanup(unsubscribeDelete);
    // AI Gateway 선별의 저장 형태·검증·승계는 core-ai-gateway가 소유한다. 호스트는 이 설정이
    // 예전에 살던 자기 소유 디렉터리만 알려 주고(플러그인 데이터 슬롯), 그 승계 판단은 하지 않는다.
    // Apply the stored target before registering routes so no request can observe an uninitialized mode.
    // dataDir는 호스트의 **유효** Fleet 루트다. 생략하면 core가 실제 홈(`~/.fleet`)으로 떨어져,
    // 격리 루트로 띄운 Console이 사용자의 진짜 설정을 읽고 덮어쓴다.
    const aiGatewayStore = createAiGatewaySettingsStore({
      dataDir: ctx.host.paths.fleetDataDir,
      legacyDir: ctx.host.paths.pluginDataDir(ctx.pluginId),
    });
    const wireLog = createWireLogRuntime(ctx);
    applyStoredWireLog(ctx, aiGatewayStore.read);
    ctx.host.lifecycle.registerCleanup(() => setWireLogTarget(undefined));
    /**
     * 제어 보유자가 바뀌면 이미 붙어 있는 터미널 소켓도 등급을 다시 받아야 한다. 티켓 발급
     * 시점의 판정만으로는 그때 이미 열려 있던 터미널이 옛 등급 그대로 남아, 회수한 뒤에도
     * 읽기 전용에 갇히거나 넘긴 뒤에도 계속 입력이 간다.
     */
    const unsubscribeControl = ctx.host.events.subscribe(CONTROL_HOLDER_EVENT_CHANNEL, () => { runtime.renegotiateSockets(); });
    ctx.host.lifecycle.registerCleanup(unsubscribeControl);
    registerShellRoutes(ctx, runtime);
    registerTerminalSettingsRoutes(ctx, {
      globalOptionsService: infraServices.globalOptionsService,
      aiGatewayStore,
      wireLogRuntime: wireLog,
    });
    registerTerminalModelAuthRoutes(ctx, { authService });
    const aiGatewayRuntime = registerAiGatewayRoutes(ctx, {
      readAiGatewaySettings: aiGatewayStore.read,
      readKimiApiKey: () => authService.getApiKey(KIMI_AUTH_PROVIDER_ID),
      readOpencodeApiKey: () => authService.getApiKey(OPENCODE_AUTH_PROVIDER_ID),
    });
    // Agent Operation과 Analyst는 같은 plugin storage 키를 읽되 수명은 각 라우트가 독립 소유한다.
    // store는 무상태 어댑터라 여기서 별도로 만들어도 저장 파일과 우선순위 계약은 하나로 유지된다.
    const agentCliPathStore = createAgentCliPathStore(ctx.host.storage, ctx.pluginId);
    registerAnalysisRoutes(ctx, {
      // 분석가는 이제 게이트웨이 위에서 돈다. 고를 수 있는 모델은 사용자가 켠 선별이다.
      readAiGatewaySettings: aiGatewayStore.read,
    });
    const sessionWatch = registerExperimentRoutes(ctx, {});
    const agentLaunchKinds = await registerAgentRoutes(ctx, runtime, {
      globalOptionsService: infraServices.globalOptionsService,
      readAiGatewaySettings: aiGatewayStore.read,
      aiGateway: {
        routePath: `${ctx.basePath}/${AI_GATEWAY_ROUTE_SEGMENT}`,
        origin: () => ctx.host.server.origin(),
        compactHookToken: aiGatewayRuntime.compactHookToken,
      },
      onTurnEnded: (operationId) => sessionWatch.onTurnEnded(operationId),
    });
    registerLaunchCatalog(ctx, async () => agentLaunchKinds());
  },
});

function isOperationDeletedEvent(value: unknown): value is { readonly operationId: string; readonly pluginId: string } {
  if (!value || typeof value !== "object") return false;
  const event = value as { readonly operationId?: unknown; readonly pluginId?: unknown };
  return typeof event.operationId === "string" && typeof event.pluginId === "string";
}
