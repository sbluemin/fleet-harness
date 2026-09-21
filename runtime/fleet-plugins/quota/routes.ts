import { definePlugin, registerRouter } from "@fleet-console/sdk/plugin/node";
import type { QuotaService, QuotaSummaryDto } from "@fleet-console/ai-gateway";

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
    // 공급자 수집과 캐시는 Gateway가 소유한다. 플러그인은 패널 설정과 명시적 새로고침만 전달한다.
    const service: Pick<QuotaService, "getSummary"> = {
      async getSummary(options = {}) {
        const origin = ctx.host.server.origin();
        if (!origin) throw new Error("Console is not listening");
        const url = new URL("/api/v1/ai-gateway/quota", origin);
        if (options.force) url.searchParams.set("force", "1");
        if (options.forceProvider) url.searchParams.set("forceProvider", options.forceProvider);
        const response = await fetch(url, {
          headers: { Origin: origin, Accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(25_000),
        });
        if (!response.ok) throw new Error("Gateway quota lookup failed");
        return await response.json() as QuotaSummaryDto;
      },
    };
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
