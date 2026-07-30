import { definePlugin, registerRouter } from "@fleet-console/sdk/plugin/node";

import { handleConnect, handleSummary } from "./server/handlers.js";
import { createQuotaService } from "./server/service.js";

export default definePlugin({
  id: "quota",
  register(ctx) {
    const service = createQuotaService({
      platform: process.platform,
      isClaudeConnected: async () => {
        const value = await ctx.host.storage.readJson("quota", "settings");
        return value !== null
          && typeof value === "object"
          && !Array.isArray(value)
          && (value as { readonly claudeConnected?: unknown }).claudeConnected === true;
      },
    });
    registerRouter(ctx, "summary", async ({ req, res }) => {
      await handleSummary(req, res, ctx, service);
      return true;
    });
    registerRouter(ctx, "connect", async ({ req, res }) => {
      await handleConnect(req, res, ctx, service);
      return true;
    });
  },
});
