import type { HttpSecurityPort } from "@fleet-console/infra/http/host-ports";
import type { HttpPort } from "@fleet-console/infra/http/host-ports";
import type { LoginStart, LoginStatus } from "@fleet-console/ai-gateway";
import type { ApiCatalogEntry } from "@fleet-console/infra/http/catalog";
import type { RouteHandler } from "@fleet-console/infra/http/routing";

interface OAuthHostContext {
  readonly basePath: string;
  readonly host: {
    readonly http: Pick<HttpPort, "readJsonBody" | "writeJson">;
    readonly security: Pick<HttpSecurityPort, "isTerminalAuthorized">;
  };
  registerRouter(path: string, handler: RouteHandler, catalog?: ApiCatalogEntry | readonly ApiCatalogEntry[]): void;
}

/** Console이 로그인을 소유하는 공급자. 마운트 경로 조각이자 플러그인 프록시의 경로 조각이다. */
export type ConsoleOAuthProvider = "muse-code" | "codex" | "xai" | "claude";

/** 공급자 로그인 모듈이 라우트에 내주는 면. 자격·device code는 이 면을 넘지 않는다. */
export interface ConsoleOAuthRoutesTarget {
  start(): Promise<LoginStart>;
  status(loginId: string): LoginStatus | undefined;
  cancel(loginId: string): LoginStatus | undefined;
  /** 없는 공급자는 로그아웃 라우트도 없다. Claude는 터미널 로그인까지 끊기므로 두지 않는다. */
  logout?(): Promise<void>;
  /**
   * 사람이 다른 기기에서 받은 코드를 진행 중인 로그인에 전한다. 코드가 없는 공급자는 이 라우트가 없다.
   * 코드는 응답·오류·로그에 싣지 않는다.
   */
  paste?(loginId: string, code: unknown): "accepted" | "not_found" | "not_pending" | "invalid_code";
}

/** OAuth는 Console 기능이다. 플러그인은 이 라우트만 프록시하며 자격이나 폴링을 소유하지 않는다. */
export function registerConsoleOAuthRoutes(
  ctx: OAuthHostContext,
  provider: ConsoleOAuthProvider,
  label: string,
  oauth: ConsoleOAuthRoutesTarget,
): void {
  const mount = `ai-gateway/oauth/${provider}`;
  ctx.registerRouter(mount, async ({ req, res, pathname }) => {
    const route = pathname.slice(`${ctx.basePath}/${mount}`.length);
    const routes = ["/start", "/status", "/cancel", ...(oauth.logout ? ["/logout"] : []), ...(oauth.paste ? ["/paste"] : [])];
    if (!routes.includes(route)) return false;
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
    if (route === "/paste") {
      const { loginId, code } = body as { loginId?: unknown; code?: unknown };
      if (fields.length !== 2 || typeof loginId !== "string" || loginId.length === 0 || loginId.length > 128 || typeof code !== "string") {
        ctx.host.http.writeJson(res, 400, { error: "invalid_paste_request" });
        return true;
      }
      const result = oauth.paste!(loginId, code);
      if (result === "accepted") ctx.host.http.writeJson(res, 200, { accepted: true });
      else ctx.host.http.writeJson(res, result === "not_found" ? 404 : result === "not_pending" ? 409 : 400, { error: result === "not_found" ? "login_not_found" : result });
      return true;
    }
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
      else { await oauth.logout!(); ctx.host.http.writeJson(res, 200, { signedIn: false }); }
    } catch {
      // 공급자의 원문·토큰·저장소 경로를 일반 오류 응답에 싣지 않는다.
      ctx.host.http.writeJson(res, 502, { error: route === "/start" ? "login_start_failed" : "logout_failed" });
    }
    return true;
  }, [
    { method: "POST", path: "/start", summary: `Start ${label} sign-in.`, category: "AI Gateway", gate: "origin-write", transport: "http" },
    { method: "GET", path: "/status", summary: `Read ${label} sign-in progress.`, category: "AI Gateway", gate: "origin-write", transport: "http" },
    { method: "POST", path: "/cancel", summary: `Cancel ${label} sign-in.`, category: "AI Gateway", gate: "origin-write", transport: "http" },
    ...(oauth.paste ? [{ method: "POST", path: "/paste", summary: `Pass the code a person copied from the ${label} sign-in page.`, category: "AI Gateway", gate: "origin-write", transport: "http" } as const] : []),
    ...(oauth.logout ? [{ method: "POST", path: "/logout", summary: `Remove the local ${label} sign-in.`, category: "AI Gateway", gate: "origin-write", transport: "http" } as const] : []),
  ]);
}
