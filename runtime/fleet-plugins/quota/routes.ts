import { definePlugin, registerRouter } from "@fleet-console/sdk/plugin/node";
import {
  createAiGatewayQuotaCollectors,
  createProviderAuthService,
  createQuotaService,
} from "@dotobokuri/core-ai-gateway";

import { handleConnect, handleFold, handleOrder, handleSummary } from "./server/handlers.js";

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
        // dataDir는 호스트의 **유효** Fleet 루트다. 생략하면 격리 루트로 띄운 Console이
        // 사용자의 진짜 auth.json을 읽는다.
        authService: createProviderAuthService({ dataDir: ctx.host.paths.fleetDataDir }),
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
    registerRouter(ctx, "fold", async ({ req, res }) => {
      await handleFold(req, res, ctx, serializeSettings);
      return true;
    }, { method: "POST", path: "", summary: "Persist which provider cards are collapsed.", category: "Quota Plugin", gate: "origin-write", transport: "http" });
  },
});
