import path from "node:path";

import type { OperationLaunchKind } from "@fleet-console/sdk/operations";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { definePlugin, registerLaunchCatalog, registerWsHandler } from "@fleet-console/sdk/plugin/node";
import { createInfraServices } from "@dotobokuri/core-infra";
import { createCarrierRegistry, initStore, registerDefaultCarriers } from "@dotobokuri/fleet-carriers";
import { KIMI_AUTH_PROVIDER_ID, OPENCODE_AUTH_PROVIDER_ID } from "@dotobokuri/fleet-admiral";
import {
  DEFAULT_WIRE_LOG_MAX_BYTES,
  setWireLogTarget,
  wireLogEnabled,
} from "@dotobokuri/core-ai-gateway";

import { registerAgentRoutes } from "./server/agent.js";
import { registerAnalysisRoutes } from "./server/agent-api/analysis-routes.js";
import { AI_GATEWAY_ROUTE_SEGMENT, registerAiGatewayRoutes } from "./server/ai-gateway-routes.js";
import { createAiGatewaySettingsStore } from "./server/ai-gateway-settings.js";
import type { AiGatewayStoredSettings } from "./server/ai-gateway-settings.js";
import { createAgentCliPathStore } from "./server/agent-api/agent-cli-paths.js";
import { registerCarrierSettingsRoutes } from "./server/carrier-settings-routes.js";
import { registerGlobalShellRoutes } from "./server/global.js";
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

async function applyStoredWireLog(ctx: FleetPluginServerContext, read: () => Promise<AiGatewayStoredSettings>): Promise<void> {
  try {
    applyWireLog(ctx, (await read()).wireLogEnabled);
  } catch {
    // Malformed plugin storage must not prevent the built-in plugin from starting;
    // fail closed by overriding any env target until a valid setting is available.
    applyWireLog(ctx, false);
  }
}

const TERMINAL_PLUGIN_ID = "terminal";
const TERMINAL_SENSITIVE_FIELDS = ["cwd", "canonicalCwd", "providerSession", "providerTitle", "transcriptPath", "token", "ticket", "prompt", "persona", "toolAllowlist"] as const;
const SHELL_LAUNCH_KIND = { id: "shell", type: "shell", title: "Shell" } as const satisfies OperationLaunchKind;
const OPERATION_DELETED_EVENT_CHANNEL = "operation:deleted";

export default definePlugin({
  id: TERMINAL_PLUGIN_ID,
  name: "Terminal",
  async register(ctx) {
    ctx.host.operations.registerOperationType("shell");
    ctx.host.operations.registerOperationType("agent");
    ctx.host.operations.registerPayloadSanitizer(ctx.pluginId, TERMINAL_SENSITIVE_FIELDS);
    const infraServices = createInfraServices();
    initStore(ctx.host.paths.fleetDataDir);
    const carrierRegistry = createCarrierRegistry();
    registerDefaultCarriers(carrierRegistry);
    const runtime = createTerminalRuntime(ctx);
    registerWsHandler(ctx, "/", runtime.handleUpgrade);
    ctx.host.lifecycle.registerCleanup(() => runtime.stop());
    const unsubscribeDelete = ctx.host.events.subscribe(OPERATION_DELETED_EVENT_CHANNEL, (payload) => {
      if (!isOperationDeletedEvent(payload) || payload.pluginId !== ctx.pluginId) return;
      runtime.terminate(payload.operationId);
    });
    ctx.host.lifecycle.registerCleanup(unsubscribeDelete);
    // AI Gateway 선별은 콘솔 durable state(plugins.terminal["ai-gateway"]) 소유 — Fleet 전역 옵션이 아니다.
    // Apply the stored target before registering routes so no request can observe an uninitialized mode.
    const aiGatewayStore = createAiGatewaySettingsStore(ctx.host.storage, ctx.pluginId);
    const wireLog = createWireLogRuntime(ctx);
    await applyStoredWireLog(ctx, aiGatewayStore.read);
    ctx.host.lifecycle.registerCleanup(() => setWireLogTarget(undefined));
    registerShellRoutes(ctx, runtime);
    registerGlobalShellRoutes(ctx, runtime);
    registerTerminalSettingsRoutes(ctx, {
      globalOptionsService: infraServices.globalOptionsService,
      aiGatewayStore,
      wireLogRuntime: wireLog,
    });
    registerTerminalModelAuthRoutes(ctx, { authService: infraServices.authService });
    registerAiGatewayRoutes(ctx, {
      readAiGatewaySettings: aiGatewayStore.read,
      readKimiApiKey: () => infraServices.authService.getApiKey(KIMI_AUTH_PROVIDER_ID),
      readOpencodeApiKey: () => infraServices.authService.getApiKey(OPENCODE_AUTH_PROVIDER_ID),
    });
    registerCarrierSettingsRoutes(ctx, { registry: carrierRegistry });
    // Agent Operation과 Analyst는 같은 plugin storage 키를 읽되 수명은 각 라우트가 독립 소유한다.
    // store는 무상태 어댑터라 여기서 별도로 만들어도 저장 파일과 우선순위 계약은 하나로 유지된다.
    const agentCliPathStore = createAgentCliPathStore(ctx.host.storage, ctx.pluginId);
    registerAnalysisRoutes(ctx, {
      readAgentCliPaths: async () => (await agentCliPathStore.read()).paths,
    });
    const agentLaunchKinds = registerAgentRoutes(ctx, runtime, {
      globalOptionsService: infraServices.globalOptionsService,
      readAiGatewaySettings: aiGatewayStore.read,
      aiGateway: {
        routePath: `${ctx.basePath}/${AI_GATEWAY_ROUTE_SEGMENT}`,
        origin: () => ctx.host.server.origin(),
      },
    });
    registerLaunchCatalog(ctx, async () => [...await agentLaunchKinds(), SHELL_LAUNCH_KIND]);
  },
});

function isOperationDeletedEvent(value: unknown): value is { readonly operationId: string; readonly pluginId: string } {
  if (!value || typeof value !== "object") return false;
  const event = value as { readonly operationId?: unknown; readonly pluginId?: unknown };
  return typeof event.operationId === "string" && typeof event.pluginId === "string";
}
