import type http from "node:http";

import type { GlobalOptionsData, GlobalOptionsService } from "@dotobokuri/core-infra";
import { getEffortLevels, getProviderModelIds } from "@dotobokuri/core-unified-agent";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { registerRouter } from "@fleet-console/sdk/plugin/node";

interface TerminalSettingsRouteDeps {
  readonly globalOptionsService: GlobalOptionsService;
}

interface TerminalSettingsBody {
  readonly enableMetaphor?: unknown;
  readonly codexLaunchMode?: unknown;
  readonly kimiModel?: unknown;
}

type TerminalSettingsUpdate =
  | { readonly enableMetaphor: boolean }
  | { readonly codexLaunchMode: "acp" | "app-server" }
  | { readonly kimiModel: { readonly model: string; readonly effort?: string } };

export interface TerminalSettingsState {
  readonly enableMetaphor: boolean;
  readonly codexLaunchMode: "acp" | "app-server";
  readonly kimiModel: { readonly model: string; readonly effort?: string } | null;
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
    codexLaunchMode: data.codexLaunchMode ?? "app-server",
    kimiModel: data.kimiModel ?? null,
  };
}

function isTerminalSettingsBody(value: unknown): value is TerminalSettingsUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  // 계약: 알려진 설정 키 중 정확히 하나만 허용한다(추가 키와 복수 키는 거부).
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  const body = value as TerminalSettingsBody;
  if (keys[0] === "enableMetaphor") return typeof body.enableMetaphor === "boolean";
  if (keys[0] === "codexLaunchMode") return body.codexLaunchMode === "acp" || body.codexLaunchMode === "app-server";
  return keys[0] === "kimiModel" && isKimiModelSetting(body.kimiModel);
}

// Kimi 프로바이더 기본 모델 설정 검증: 모델은 레지스트리 ID여야 하고,
// effort는 모델이 effort를 지원할 때만 허용 레벨 내 값이어야 한다.
function isKimiModelSetting(value: unknown): value is { readonly model: string; readonly effort?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as { model?: unknown; effort?: unknown };
  if (typeof record.model !== "string" || !getProviderModelIds("claude-kimi").includes(record.model)) return false;
  const levels = getEffortLevels("claude-kimi", record.model);
  if (record.effort === undefined) return true;
  if (!levels || typeof record.effort !== "string") return false;
  return levels.includes(record.effort);
}

function isJsonRequest(req: http.IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  return typeof contentType === "string" && contentType.toLowerCase().split(";")[0]?.trim() === "application/json";
}
