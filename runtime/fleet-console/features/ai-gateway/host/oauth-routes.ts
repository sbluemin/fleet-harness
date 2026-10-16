import type { MuseCodeOAuth } from "@fleet-console/ai-gateway";
import type { ApiCatalogEntry, FleetPluginHostCapabilities } from "@fleet-console/sdk/plugin";
import type { RouteHandler } from "@fleet-console/sdk/routing";

interface OAuthHostContext {
  readonly basePath: string;
  readonly host: {
    readonly http: Pick<FleetPluginHostCapabilities["http"], "readJsonBody" | "writeJson">;
    readonly security: Pick<FleetPluginHostCapabilities["security"], "isTerminalAuthorized">;
  };
  registerRouter(path: string, handler: RouteHandler, catalog?: ApiCatalogEntry | readonly ApiCatalogEntry[]): void;
}

/** OAuth는 Console 기능이다. 플러그인은 이 라우트만 프록시하며 자격이나 폴링을 소유하지 않는다. */
export function registerMuseCodeOAuthRoutes(ctx: OAuthHostContext, oauth: MuseCodeOAuth): void {
  const mount = "ai-gateway/oauth/muse-code";
  ctx.registerRouter(mount, async ({ req, res, pathname }) => {
    const route = pathname.slice(`${ctx.basePath}/${mount}`.length);
    if (!["/start", "/status", "/cancel", "/logout"].includes(route)) return false;
    if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return true; }
    if (req.method !== (route === "/status" ? "GET" : "POST")) { ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (route === "/status") {
      const loginId = new URL(req.url ?? "/", "http://localhost").searchParams.get("loginId");
      const status = loginId && loginId.length <= 128 ? oauth.status(loginId) : undefined;
      ctx.host.http.writeJson(res, status ? 200 : 404, status ?? { error: "login_not_found" });
      return true;
    }
    const contentType = req.headers["content-type"]?.toLowerCase().split(";")[0]?.trim();
    if (contentType !== "application/json") { ctx.host.http.writeJson(res, 415, { error: "json_required" }); return true; }
    const body = await ctx.host.http.readJsonBody<unknown>(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) { ctx.host.http.writeJson(res, 400, { error: "invalid_json" }); return true; }
    const fields = Object.keys(body);
    if (route === "/cancel") {
      const loginId = (body as { loginId?: unknown }).loginId;
      if (fields.length !== 1 || typeof loginId !== "string" || loginId.length > 128) { ctx.host.http.writeJson(res, 400, { error: "invalid_login_id" }); return true; }
      const status = oauth.cancel(loginId);
      ctx.host.http.writeJson(res, status ? 200 : 404, status ?? { error: "login_not_found" });
      return true;
    }
    if (fields.length !== 0) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return true; }
    try {
      if (route === "/start") ctx.host.http.writeJson(res, 200, await oauth.start());
      else { await oauth.logout(); ctx.host.http.writeJson(res, 200, { signedIn: false }); }
    } catch {
      // 공급자의 원문·토큰·저장소 경로를 일반 오류 응답에 싣지 않는다.
      ctx.host.http.writeJson(res, 502, { error: route === "/start" ? "login_start_failed" : "logout_failed" });
    }
    return true;
  }, [
    { method: "POST", path: "/start", summary: "Start Muse Code device sign-in.", category: "AI Gateway", gate: "origin-write", transport: "http" },
    { method: "GET", path: "/status", summary: "Read Muse Code sign-in progress.", category: "AI Gateway", gate: "origin-write", transport: "http" },
    { method: "POST", path: "/cancel", summary: "Cancel Muse Code sign-in.", category: "AI Gateway", gate: "origin-write", transport: "http" },
    { method: "POST", path: "/logout", summary: "Remove the local Muse Code sign-in.", category: "AI Gateway", gate: "origin-write", transport: "http" },
  ]);
}
