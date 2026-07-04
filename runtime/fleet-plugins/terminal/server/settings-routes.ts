import type http from "node:http";

import type { GlobalOptionsData, GlobalOptionsService } from "@dotobokuri/fleet-infra";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { registerRouter } from "@fleet-console/sdk/plugin/node";

interface TerminalSettingsRouteDeps {
  readonly globalOptionsService: GlobalOptionsService;
}

interface TerminalSettingsBody {
  readonly enableMetaphor?: unknown;
}

interface TerminalSettingsUpdate {
  readonly enableMetaphor: boolean;
}

export interface TerminalSettingsState {
  readonly enableMetaphor: boolean;
}

export function registerTerminalSettingsRoutes(ctx: FleetPluginServerContext, deps: TerminalSettingsRouteDeps): void {
  registerRouter(ctx, "settings", async ({ req, res }) => {
    if (req.method === "GET") {
      // 상류 host 게이트(server.ts:423)로 loopback이 보장된다. 플러그인 컨텍스트에는 콘솔 포트가 없다.
      ctx.host.http.writeJson(res, 200, toTerminalSettingsState(deps.globalOptionsService.load()));
      return true;
    }
    if (req.method === "PUT") {
      if (!ctx.host.security.isTerminalAuthorized(req)) {
        ctx.host.http.writeJson(res, 401, { error: "unauthorized" });
        return true;
      }
      if (!isJsonRequest(req)) {
        ctx.host.http.writeJson(res, 415, { error: "unsupported_media_type" });
        return true;
      }
      const body = await ctx.host.http.readJsonBody<TerminalSettingsBody>(req);
      if (!isTerminalSettingsBody(body)) {
        ctx.host.http.writeJson(res, 400, { error: "invalid_terminal_settings" });
        return true;
      }
      const updated = deps.globalOptionsService.update((current) => ({
        ...current,
        enableMetaphor: body.enableMetaphor,
      }));
      ctx.host.http.writeJson(res, 200, toTerminalSettingsState(updated));
      return true;
    }
    ctx.host.http.writeJson(res, 405, { error: "Method not allowed" });
    return true;
  });
}

export function toTerminalSettingsState(data: GlobalOptionsData): TerminalSettingsState {
  return {
    enableMetaphor: data.enableMetaphor ?? false,
  };
}

function isTerminalSettingsBody(value: unknown): value is TerminalSettingsUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  // 계약: enableMetaphor 단일 키만 허용한다(추가 키는 거부).
  if (Object.keys(value).length !== 1) return false;
  const body = value as TerminalSettingsBody;
  return typeof body.enableMetaphor === "boolean";
}

function isJsonRequest(req: http.IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  return typeof contentType === "string" && contentType.toLowerCase().split(";")[0]?.trim() === "application/json";
}
