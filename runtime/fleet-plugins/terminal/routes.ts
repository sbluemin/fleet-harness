import type { OperationLaunchKind } from "@fleet-console/sdk/operations";
import { definePlugin, registerLaunchCatalog } from "@fleet-console/sdk/plugin/node";

import { registerAgentRoutes } from "./server/agent.js";
import { registerShellRoutes } from "./server/shell.js";

const TERMINAL_PLUGIN_ID = "terminal";
const TERMINAL_SENSITIVE_FIELDS = ["cwd", "canonicalCwd", "providerSession", "transcriptPath", "token", "ticket", "prompt", "persona", "toolAllowlist"] as const;
const SHELL_LAUNCH_KIND = { id: "shell", type: "shell", title: "Shell" } as const satisfies OperationLaunchKind;

export default definePlugin({
  id: TERMINAL_PLUGIN_ID,
  name: "Terminal",
  register(ctx) {
    ctx.host.operations.registerOperationType("shell");
    ctx.host.operations.registerOperationType("agent");
    ctx.host.operations.registerOperationType("agent.streaming");
    ctx.host.operations.registerPayloadSanitizer(ctx.pluginId, TERMINAL_SENSITIVE_FIELDS);
    registerShellRoutes(ctx);
    const agentLaunchKinds = registerAgentRoutes(ctx);
    registerLaunchCatalog(ctx, async () => [SHELL_LAUNCH_KIND, ...await agentLaunchKinds()]);
  },
});
