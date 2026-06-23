import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { agentAttentionNotification, agentOperationKind, agentPlugin, agentSettingsSection, agentStreamingOperationKind } from "./agent/index.js";
import { shellOperationKind, shellPlugin } from "./shell/index.js";

const AGENT_OPERATION_TYPES = new Set(["agent", "agent.streaming"]);

export const terminalPlugin = definePlugin({
  id: "terminal",
  operationKinds: [shellOperationKind, agentOperationKind, agentStreamingOperationKind],
  settingsSections: [agentSettingsSection],
  notificationKinds: [agentAttentionNotification],
  install: (ctx) => agentPlugin.install?.(ctx),
  closeOperation: async (operationId) => {
    const operation = await fetchOperation(operationId);
    if (operation?.type === "shell") {
      await shellPlugin.closeOperation?.(operationId);
      return;
    }
    if (operation && AGENT_OPERATION_TYPES.has(operation.type)) {
      await agentPlugin.closeOperation?.(operationId);
    }
  },
  launch: async (ctx) => ctx.kind.type === "shell"
    ? shellPlugin.launch?.(ctx) ?? { id: "" }
    : agentPlugin.launch?.(ctx) ?? { id: "" },
  renderLaunchIcon: (kind) => kind.type === "shell" ? shellPlugin.renderLaunchIcon?.(kind) : agentPlugin.renderLaunchIcon?.(kind),
});

export const operationKinds = [shellOperationKind, agentOperationKind, agentStreamingOperationKind] as const;
export const settingsSections = [agentSettingsSection] as const;
export const notificationKinds = [agentAttentionNotification] as const;
export const plugins = [terminalPlugin] as const;

async function fetchOperation(operationId: string): Promise<{ readonly type: string } | null> {
  const response = await fetch(`/operations/${encodeURIComponent(operationId)}`);
  if (!response.ok) return null;
  const payload = await response.json() as { readonly operation?: { readonly type?: unknown } };
  return typeof payload.operation?.type === "string" ? { type: payload.operation.type } : null;
}
