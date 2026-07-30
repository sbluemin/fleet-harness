import { definePlugin, registerRouter } from "@fleet-console/sdk/plugin/node";

import { handleConnect, handleSummary } from "./server/handlers.js";
import { createQuotaService } from "./server/service.js";

export default definePlugin({
  id: "quota",
  register(ctx) {
    let settingsMutation = Promise.resolve();
    const serializeSettings = <T>(operation: () => Promise<T>): Promise<T> => {
      const result = settingsMutation.then(operation, operation);
      settingsMutation = result.then(() => undefined, () => undefined);
      return result;
    };
    const isConnected = async (provider: "claude" | "cursor") => {
      const value = await ctx.host.storage.readJson("quota", "settings");
      return value !== null
        && typeof value === "object"
        && !Array.isArray(value)
        && (value as Record<string, unknown>)[`${provider}Connected`] === true;
    };
    const service = createQuotaService({
      platform: process.platform,
      isClaudeConnected: () => isConnected("claude"),
      isCursorConnected: () => isConnected("cursor"),
    });
    registerRouter(ctx, "summary", async ({ req, res }) => {
      await handleSummary(req, res, ctx, service);
      return true;
    });
    registerRouter(ctx, "connect", async ({ req, res }) => {
      await handleConnect(req, res, ctx, service, serializeSettings);
      return true;
    });
  },
});
