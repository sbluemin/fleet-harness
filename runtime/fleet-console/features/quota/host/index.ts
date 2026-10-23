import type { ApiCatalogEntry, FleetPluginHostCapabilities } from "@fleet-console/sdk/plugin";
import type { RouteHandler } from "@fleet-console/sdk/routing";
import {
  handleConnect,
  handleProviderLogin,
  handleSummary,
  LOGIN_PROVIDERS,
  type GatewayQuotaSummary,
  type LoginAction,
  type LoginGateway,
  type LoginProvider,
  type QuotaSummarySource,
} from "./handlers.js";

const LOGIN_LABEL: Readonly<Record<LoginProvider, string>> = {
  "muse-code": "Muse Code",
  codex: "Codex",
  xai: "xAI",
  cursor: "Cursor",
};

const LOGIN_ROUTES: readonly { readonly action: LoginAction; readonly method: "GET" | "POST"; readonly summary: (label: string) => string }[] = [
  { action: "start", method: "POST", summary: (label) => `Start ${label} sign-in from the quota panel.` },
  { action: "status", method: "GET", summary: (label) => `Read ${label} sign-in progress for the quota panel.` },
  { action: "cancel", method: "POST", summary: (label) => `Cancel ${label} sign-in from the quota panel.` },
  { action: "logout", method: "POST", summary: (label) => `Remove the local ${label} sign-in from the quota panel.` },
];

export type QuotaFeatureDeps = Pick<FleetPluginHostCapabilities, "server" | "storage" | "http" | "security">;
export interface QuotaRouteContext { readonly host: QuotaFeatureDeps }
export function createQuotaFeature(deps: QuotaFeatureDeps) {
  const ctx = { host: deps };
  const routes: { path: string; handler: RouteHandler; catalog: readonly ApiCatalogEntry[] }[] = [];
  const addRoute = (name: string, handler: RouteHandler, catalog: ApiCatalogEntry) => {
    const path = `/api/v1/quota/${name}`;
    routes.push({ path, handler, catalog: [{ ...catalog, path: path + catalog.path }] });
  };
  let settingsMutation = Promise.resolve();
  const serializeSettings = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = settingsMutation.then(operation, operation);
    settingsMutation = result.then(() => undefined, () => undefined);
    return result;
  };
  // 공급자 수집과 캐시는 Gateway가 소유한다. 플러그인은 Claude 연결 동의와 명시적 새로고침만 전달한다.
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
  // 공급자 로그인은 Console(Gateway)이 소유한다. 플러그인은 getSummary처럼 공개 라우트를 옮겨 부를 뿐이다.
  const login: LoginGateway = {
    async call(provider, action, request) {
      const origin = ctx.host.server.origin();
      if (!origin) throw new Error("Console is not listening");
      const url = new URL(`/api/v1/ai-gateway/oauth/${provider}/${action}`, origin);
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
  addRoute("summary", async ({ req, res }) => {
    await handleSummary(req, res, ctx, service);
    return true;
  }, { method: "GET", path: "", summary: "Read provider quota summary.", category: "Quota", gate: "origin-write", transport: "http" });
  addRoute("connect", async ({ req, res }) => {
    await handleConnect(req, res, ctx, service, serializeSettings);
    return true;
  }, { method: "POST", path: "", summary: "Update provider quota connection state.", category: "Quota", gate: "origin-write", transport: "http" });
  for (const provider of LOGIN_PROVIDERS) {
    for (const route of LOGIN_ROUTES) {
      addRoute(`${provider}/${route.action}`, async ({ req, res }) => {
        await handleProviderLogin(req, res, ctx, provider, route.action, login, service);
        return true;
      }, { method: route.method, path: "", summary: route.summary(LOGIN_LABEL[provider]), category: "Quota", gate: "origin-write", transport: "http" });
    }
  }
  return { routes };
}
