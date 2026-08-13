import { definePlugin, registerRouter } from "@fleet-console/sdk/plugin/node";
import {
  createAiGatewayQuotaCollectors,
  createQuotaService,
} from "@dotobokuri/core-ai-gateway";
import { createAuthService, DEFAULT_AUTH_PATH } from "@dotobokuri/core-infra";

import { handleConnect, handleOrder, handleSummary } from "./server/handlers.js";

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
      ...createAiGatewayQuotaCollectors({
        authService: createAuthService({ authPath: DEFAULT_AUTH_PATH }),
      }),
    });
    registerRouter(ctx, "summary", async ({ req, res }) => {
      await handleSummary(req, res, ctx, service);
      return true;
    }, { method: "GET", path: "", summary: "Read provider quota summary.", category: "Quota Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "connect", async ({ req, res }) => {
      await handleConnect(req, res, ctx, service, serializeSettings);
      return true;
    }, { method: "POST", path: "", summary: "Update provider quota connection state.", category: "Quota Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "order", async ({ req, res }) => {
      await handleOrder(req, res, ctx, serializeSettings);
      return true;
    }, { method: "POST", path: "", summary: "Persist the provider card order.", category: "Quota Plugin", gate: "origin-write", transport: "http" });
  },
});
