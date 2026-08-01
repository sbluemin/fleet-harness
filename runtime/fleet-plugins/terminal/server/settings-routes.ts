import type http from "node:http";

import type { GlobalOptionsData, GlobalOptionsService } from "@dotobokuri/core-infra";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { registerRouter } from "@fleet-console/sdk/plugin/node";

interface TerminalSettingsRouteDeps {
  readonly globalOptionsService: GlobalOptionsService;
}

interface TerminalSettingsBody {
  readonly enableMetaphor?: unknown;
  readonly agentIdleDormantMinutes?: unknown;
}

type TerminalSettingsUpdate =
  | { readonly enableMetaphor: boolean }
  | { readonly agentIdleDormantMinutes: number | null };

export const DEFAULT_AGENT_IDLE_DORMANT_MINUTES = 60;

export interface TerminalSettingsState {
  readonly enableMetaphor: boolean;
  readonly agentIdleDormantMinutes: number | null;
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
        ...body,
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
    agentIdleDormantMinutes: data.agentIdleDormantMinutes === undefined
      ? DEFAULT_AGENT_IDLE_DORMANT_MINUTES
      : data.agentIdleDormantMinutes,
  };
}

export function resolveAgentIdleDormantMinutes(data: GlobalOptionsData): number | null {
  return data.agentIdleDormantMinutes === undefined
    ? DEFAULT_AGENT_IDLE_DORMANT_MINUTES
    : data.agentIdleDormantMinutes;
}

function isTerminalSettingsBody(value: unknown): value is TerminalSettingsUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  // 계약: 알려진 설정 키 중 정확히 하나만 허용한다(추가 키와 복수 키는 거부).
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  const body = value as TerminalSettingsBody;
  if (keys[0] === "enableMetaphor") return typeof body.enableMetaphor === "boolean";
  if (keys[0] === "agentIdleDormantMinutes") return isAgentIdleDormantMinutes(body.agentIdleDormantMinutes);
  return false;
}

function isAgentIdleDormantMinutes(value: unknown): value is number | null {
  if (value === null) return true;
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

function isJsonRequest(req: http.IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  return typeof contentType === "string" && contentType.toLowerCase().split(";")[0]?.trim() === "application/json";
}
