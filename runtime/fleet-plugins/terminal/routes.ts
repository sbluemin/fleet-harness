import type { OperationLaunchKind } from "@fleet-console/sdk/operations";
import { definePlugin, registerLaunchCatalog, registerWsHandler } from "@fleet-console/sdk/plugin/node";
import { createInfraServices } from "@dotobokuri/core-infra";
import { createCarrierRegistry, registerDefaultCarriers } from "@dotobokuri/fleet-carriers";

import { registerAgentRoutes } from "./server/agent.js";
import { registerCarrierSettingsRoutes } from "./server/carrier-settings-routes.js";
import { registerGlobalShellRoutes } from "./server/global.js";
import { registerTerminalSettingsRoutes } from "./server/settings-routes.js";
import { createTerminalRuntime } from "./server/shared/index.js";
import { registerShellRoutes } from "./server/shell.js";

const TERMINAL_PLUGIN_ID = "terminal";
const TERMINAL_SENSITIVE_FIELDS = ["cwd", "canonicalCwd", "providerSession", "transcriptPath", "token", "ticket", "prompt", "persona", "toolAllowlist"] as const;
const SHELL_LAUNCH_KIND = { id: "shell", type: "shell", title: "Shell" } as const satisfies OperationLaunchKind;
const OPERATION_DELETED_EVENT_CHANNEL = "operation:deleted";

export default definePlugin({
  id: TERMINAL_PLUGIN_ID,
  name: "Terminal",
  register(ctx) {
    ctx.host.operations.registerOperationType("shell");
    ctx.host.operations.registerOperationType("agent");
    ctx.host.operations.registerPayloadSanitizer(ctx.pluginId, TERMINAL_SENSITIVE_FIELDS);
    const infraServices = createInfraServices();
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
    registerShellRoutes(ctx, runtime);
    registerGlobalShellRoutes(ctx, runtime);
    registerTerminalSettingsRoutes(ctx, { globalOptionsService: infraServices.globalOptionsService });
    registerCarrierSettingsRoutes(ctx, { registry: carrierRegistry });
    const agentLaunchKinds = registerAgentRoutes(ctx, runtime, {
      globalOptionsService: infraServices.globalOptionsService,
    });
    registerLaunchCatalog(ctx, async () => [...await agentLaunchKinds(), SHELL_LAUNCH_KIND]);
  },
});

function isOperationDeletedEvent(value: unknown): value is { readonly operationId: string; readonly pluginId: string } {
  if (!value || typeof value !== "object") return false;
  const event = value as { readonly operationId?: unknown; readonly pluginId?: unknown };
  return typeof event.operationId === "string" && typeof event.pluginId === "string";
}
