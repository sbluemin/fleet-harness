import { definePlugin, registerRouter } from "@fleet-console/sdk/plugin/node";
import {
  handleConnect,
  handleMuseLogin,
  handleSummary,
  type GatewayQuotaSummary,
  type MuseLoginAction,
  type MuseLoginGateway,
  type QuotaSummarySource,
} from "./server/handlers.js";

const MUSE_LOGIN_ROUTES: readonly { readonly action: MuseLoginAction; readonly method: "GET" | "POST"; readonly summary: string }[] = [
  { action: "start", method: "POST", summary: "Start Muse Code sign-in from the quota panel." },
  { action: "status", method: "GET", summary: "Read Muse Code sign-in progress for the quota panel." },
  { action: "cancel", method: "POST", summary: "Cancel Muse Code sign-in from the quota panel." },
  { action: "logout", method: "POST", summary: "Remove the local Muse Code sign-in from the quota panel." },
];

export default definePlugin({
  id: "quota",
  register(ctx) {
    let settingsMutation = Promise.resolve();
    const serializeSettings = <T>(operation: () => Promise<T>): Promise<T> => {
      const result = settingsMutation.then(operation, operation);
      settingsMutation = result.then(() => undefined, () => undefined);
      return result;
    };
    // 공급자 수집과 캐시는 Gateway가 소유한다. 플러그인은 연결 동의와 명시적 새로고침만 전달한다.
    const service: QuotaSummarySource = {
      async getSummary(options = {}) {
        const origin = ctx.host.server.origin();
        if (!origin) throw new Error("Console is not listening");
        const url = new URL("/api/v1/ai-gateway/quota", origin);
        if (options.force) url.searchParams.set("force", "1");
        if (options.forceProvider) url.searchParams.set("forceProvider", options.forceProvider);
        if (options.stale) url.searchParams.set("stale", "1");
        const response = await fetch(url, {
          headers: { Origin: origin, Accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(25_000),
        });
        if (!response.ok) throw new Error("Gateway quota lookup failed");
        return await response.json() as GatewayQuotaSummary;
      },
    };
    // Muse Code 로그인은 Console(Gateway)이 소유한다. 플러그인은 getSummary처럼 공개 라우트를 옮겨 부를 뿐이다.
    const museLogin: MuseLoginGateway = {
      async call(action, request) {
        const origin = ctx.host.server.origin();
        if (!origin) throw new Error("Console is not listening");
        const url = new URL(`/api/v1/ai-gateway/oauth/muse-code/${action}`, origin);
        if (request.loginId !== undefined) url.searchParams.set("loginId", request.loginId);
        const response = await fetch(url, {
          method: action === "status" ? "GET" : "POST",
          headers: {
            Origin: origin,
            Accept: "application/json",
            ...(request.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
          redirect: "error",
          signal: AbortSignal.timeout(25_000),
        });
        return { status: response.status, payload: await response.json() as unknown };
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
    for (const route of MUSE_LOGIN_ROUTES) {
      registerRouter(ctx, `muse-code/${route.action}`, async ({ req, res }) => {
        await handleMuseLogin(req, res, ctx, route.action, museLogin, service);
        return true;
      }, { method: route.method, path: "", summary: route.summary, category: "Quota Plugin", gate: "origin-write", transport: "http" });
    }
  },
});
