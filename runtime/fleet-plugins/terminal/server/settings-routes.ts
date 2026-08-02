import type http from "node:http";

import type { GlobalOptionsData, GlobalOptionsService } from "@dotobokuri/core-infra";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { registerRouter } from "@fleet-console/sdk/plugin/node";

import {
  buildAiGatewayCatalog,
  parseAiGatewayUpdate,
  type AiGatewayCatalog,
  type AiGatewaySettingsStore,
  type AiGatewayStoredSettings,
  type AiGatewayUpdateValue,
} from "./ai-gateway-settings.js";

interface TerminalSettingsRouteDeps {
  readonly globalOptionsService: GlobalOptionsService;
  readonly aiGatewayStore: AiGatewaySettingsStore;
}

interface TerminalSettingsBody {
  readonly enableMetaphor?: unknown;
  readonly agentIdleDormantMinutes?: unknown;
  readonly aiGateway?: unknown;
}

type TerminalSettingsUpdate =
  | { readonly enableMetaphor: boolean }
  | { readonly agentIdleDormantMinutes: number | null }
  | { readonly aiGateway: AiGatewayUpdateValue | undefined };

export const DEFAULT_AGENT_IDLE_DORMANT_MINUTES = 60;

export interface TerminalSettingsState {
  readonly enableMetaphor: boolean;
  readonly agentIdleDormantMinutes: number | null;
  readonly aiGateway: AiGatewayUpdateValue | null;
  readonly aiGatewayCatalog: AiGatewayCatalog;
}

export function registerTerminalSettingsRoutes(ctx: FleetPluginServerContext, deps: TerminalSettingsRouteDeps): void {
  registerRouter(ctx, "settings", async ({ req, res }) => {
    if (req.method === "GET") {
      // 상류 host 게이트(server.ts:423)로 loopback이 보장된다. 플러그인 컨텍스트에는 콘솔 포트가 없다.
      ctx.host.http.writeJson(res, 200, toTerminalSettingsState(deps.globalOptionsService.load(), await deps.aiGatewayStore.read()));
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
      const update = parseTerminalSettingsBody(body);
      if (!update) {
        ctx.host.http.writeJson(res, 400, { error: "invalid_terminal_settings" });
        return true;
      }
      if ("aiGateway" in update) {
        // AI Gateway 선별은 Fleet 전역 옵션이 아니라 콘솔 durable state의 플러그인 슬롯 소유다.
        const stored = await deps.aiGatewayStore.write(update.aiGateway);
        ctx.host.http.writeJson(res, 200, toTerminalSettingsState(deps.globalOptionsService.load(), stored));
        return true;
      }
      const updated = deps.globalOptionsService.update((current) => ({ ...current, ...update }));
      ctx.host.http.writeJson(res, 200, toTerminalSettingsState(updated, await deps.aiGatewayStore.read()));
      return true;
    }
    ctx.host.http.writeJson(res, 405, { error: "Method not allowed" });
    return true;
  });
}

export function toTerminalSettingsState(data: GlobalOptionsData, aiGateway: AiGatewayStoredSettings): TerminalSettingsState {
  const configured = (aiGateway.models?.length ?? 0) > 0 || aiGateway.defaultModel !== undefined;
  return {
    enableMetaphor: data.enableMetaphor ?? false,
    agentIdleDormantMinutes: data.agentIdleDormantMinutes === undefined
      ? DEFAULT_AGENT_IDLE_DORMANT_MINUTES
      : data.agentIdleDormantMinutes,
    aiGateway: configured
      ? {
        ...(aiGateway.models?.length ? { models: aiGateway.models } : {}),
        ...(aiGateway.defaultModel !== undefined ? { defaultModel: aiGateway.defaultModel } : {}),
      }
      : null,
    aiGatewayCatalog: buildAiGatewayCatalog(),
  };
}

export function resolveAgentIdleDormantMinutes(data: GlobalOptionsData): number | null {
  return data.agentIdleDormantMinutes === undefined
    ? DEFAULT_AGENT_IDLE_DORMANT_MINUTES
    : data.agentIdleDormantMinutes;
}

function parseTerminalSettingsBody(value: unknown): TerminalSettingsUpdate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  // 계약: 알려진 설정 키 중 정확히 하나만 허용한다(추가 키와 복수 키는 거부).
  const keys = Object.keys(value);
  if (keys.length !== 1) return null;
  const body = value as TerminalSettingsBody;
  if (keys[0] === "enableMetaphor") {
    return typeof body.enableMetaphor === "boolean" ? { enableMetaphor: body.enableMetaphor } : null;
  }
  if (keys[0] === "agentIdleDormantMinutes") {
    return isAgentIdleDormantMinutes(body.agentIdleDormantMinutes)
      ? { agentIdleDormantMinutes: body.agentIdleDormantMinutes }
      : null;
  }
  if (keys[0] === "aiGateway") {
    const parsed = parseAiGatewayUpdate(body.aiGateway);
    return parsed.ok ? { aiGateway: parsed.value } : null;
  }
  return null;
}

function isAgentIdleDormantMinutes(value: unknown): value is number | null {
  if (value === null) return true;
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

function isJsonRequest(req: http.IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  return typeof contentType === "string" && contentType.toLowerCase().split(";")[0]?.trim() === "application/json";
}
