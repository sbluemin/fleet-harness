import type http from "node:http";

import type { ClaudeCodeSystemPromptMode, GlobalOptionsData, GlobalOptionsService } from "@dotobokuri/core-infra";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { registerRouter } from "@fleet-console/sdk/plugin/node";

import {
  buildAiGatewayCatalog,
  normalizeCompactCeiling,
  parseAiGatewayUpdate,
  DEFAULT_XAI_ENDPOINT_PREFERENCE,
  XAI_ENDPOINT_PREFERENCES,
  type AiGatewayCatalog,
  type AiGatewaySettingsStore,
  type AiGatewayStoredSettings,
  type AiGatewayUpdateValue,
  type CompactCeiling,
  type XaiEndpointPreference,
} from "@dotobokuri/core-ai-gateway";

interface TerminalSettingsRouteDeps {
  readonly globalOptionsService: GlobalOptionsService;
  readonly aiGatewayStore: AiGatewaySettingsStore;
  readonly wireLogRuntime: {
    readonly enabled: () => boolean;
    readonly apply: (stored: boolean | undefined) => void;
  };
}

interface TerminalSettingsBody {
  readonly agentIdleDormantMinutes?: unknown;
  readonly claudeCodeSystemPrompt?: unknown;
  readonly claudeCodeSkipPermissions?: unknown;
  readonly aiGateway?: unknown;
  readonly cursorDiagnosticsEnabled?: unknown;
  readonly wireLogEnabled?: unknown;
  readonly compactCeiling?: unknown;
  readonly xaiEndpoint?: unknown;
}

type TerminalSettingsUpdate =
  | { readonly agentIdleDormantMinutes: number | null }
  | { readonly claudeCodeSystemPrompt: ClaudeCodeSystemPromptMode }
  | { readonly claudeCodeSkipPermissions: boolean }
  | { readonly aiGateway: AiGatewayUpdateValue | undefined }
  | { readonly cursorDiagnosticsEnabled: boolean }
  | { readonly wireLogEnabled: boolean }
  | { readonly compactCeiling: CompactCeiling | undefined }
  | { readonly xaiEndpoint: XaiEndpointPreference };

const DEFAULT_AGENT_IDLE_DORMANT_MINUTES = 60;

export interface TerminalSettingsState {
  readonly agentIdleDormantMinutes: number | null;
  readonly claudeCodeSystemPrompt: ClaudeCodeSystemPromptMode;
  readonly claudeCodeSkipPermissions: boolean;
  readonly aiGateway: AiGatewayUpdateValue | null;
  readonly aiGatewayCatalog: AiGatewayCatalog;
  readonly cursorDiagnosticsEnabled: boolean;
  readonly wireLogEnabled: boolean;
  readonly compactCeiling: CompactCeiling | null;
  readonly xaiEndpoint: XaiEndpointPreference;
}

export function registerTerminalSettingsRoutes(ctx: FleetPluginServerContext, deps: TerminalSettingsRouteDeps): void {
  registerRouter(ctx, "settings", async ({ req, res }) => {
    if (req.method === "GET") {
      // 세션 없는 요청은 상류가 이미 걷어냈다. 다만 상류가 보장하는 것은 loopback이 아니다 —
      // 원격 리스너에서 온 GET도 여기 닿고, 원격 세션은 이 콘솔의 설정 화면을 그리는 주체이므로
      // 그래야 한다. 플러그인 컨텍스트에는 콘솔 포트가 없어 여기서 Host를 다시 볼 수도 없다.
      ctx.host.http.writeJson(res, 200, toTerminalSettingsState(
        deps.globalOptionsService.load(),
        deps.aiGatewayStore.read(),
        deps.wireLogRuntime.enabled(),
      ));
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
        // AI Gateway 선별은 Fleet 전역 옵션이 아니라 core-ai-gateway가 소유하는 자기 축이다.
        const stored = deps.aiGatewayStore.write(update.aiGateway);
        ctx.host.http.writeJson(res, 200, toTerminalSettingsState(
          deps.globalOptionsService.load(), stored, deps.wireLogRuntime.enabled(),
        ));
        return true;
      }
      if ("cursorDiagnosticsEnabled" in update) {
        const stored = deps.aiGatewayStore.writeCursorDiagnosticsEnabled(
          update.cursorDiagnosticsEnabled,
        );
        ctx.host.http.writeJson(res, 200, toTerminalSettingsState(
          deps.globalOptionsService.load(), stored, deps.wireLogRuntime.enabled(),
        ));
        return true;
      }
      if ("wireLogEnabled" in update) {
        const previous = deps.aiGatewayStore.read();
        let stored: AiGatewayStoredSettings;
        try {
          stored = deps.aiGatewayStore.writeWireLogEnabled(update.wireLogEnabled);
          deps.wireLogRuntime.apply(stored.wireLogEnabled);
        } catch {
          // Durable state and the live target must move together. Restore the prior raw value
          // when applying the new target fails, including absence for env fallback.
          try {
            deps.aiGatewayStore.writeWireLogEnabled(previous.wireLogEnabled);
          } catch {
            // Preserve the original 500; the store's writer has already reported the failure.
          }
          ctx.host.http.writeJson(res, 500, { error: "wire_log_runtime_apply_failed" });
          return true;
        }
        ctx.host.http.writeJson(res, 200, toTerminalSettingsState(
          deps.globalOptionsService.load(), stored, deps.wireLogRuntime.enabled(),
        ));
        return true;
      }
      if ("compactCeiling" in update) {
        const stored = deps.aiGatewayStore.writeCompactCeiling(update.compactCeiling);
        ctx.host.http.writeJson(res, 200, toTerminalSettingsState(
          deps.globalOptionsService.load(), stored, deps.wireLogRuntime.enabled(),
        ));
        return true;
      }
      if ("xaiEndpoint" in update) {
        const stored = deps.aiGatewayStore.writeXaiEndpoint(update.xaiEndpoint);
        ctx.host.http.writeJson(res, 200, toTerminalSettingsState(
          deps.globalOptionsService.load(), stored, deps.wireLogRuntime.enabled(),
        ));
        return true;
      }
      const updated = deps.globalOptionsService.update((current) => ({ ...current, ...update }));
      ctx.host.http.writeJson(res, 200, toTerminalSettingsState(
        updated, deps.aiGatewayStore.read(), deps.wireLogRuntime.enabled(),
      ));
      return true;
    }
    ctx.host.http.writeJson(res, 405, { error: "Method not allowed" });
    return true;
  }, [
    { method: "GET", path: "", summary: "Read Terminal plugin settings.", category: "Terminal Plugin", gate: "loopback", transport: "http" },
    { method: "PUT", path: "", summary: "Save Terminal plugin settings.", category: "Terminal Plugin", gate: "origin-write", transport: "http" },
  ]);
}

function toTerminalSettingsState(
  data: GlobalOptionsData,
  aiGateway: AiGatewayStoredSettings,
  wireLogEnabled: boolean,
): TerminalSettingsState {
  const configured = (aiGateway.models?.length ?? 0) > 0
    || (aiGateway.providerPriority?.length ?? 0) > 0;
  return {
    agentIdleDormantMinutes: data.agentIdleDormantMinutes === undefined
      ? DEFAULT_AGENT_IDLE_DORMANT_MINUTES
      : data.agentIdleDormantMinutes,
    claudeCodeSystemPrompt: resolveClaudeCodeSystemPrompt(data),
    claudeCodeSkipPermissions: resolveClaudeCodeSkipPermissions(data),
    aiGateway: configured
      ? {
        ...(aiGateway.models?.length ? { models: aiGateway.models } : {}),
        ...(aiGateway.providerPriority?.length ? { providerPriority: aiGateway.providerPriority } : {}),
      }
      : null,
    aiGatewayCatalog: buildAiGatewayCatalog(),
    cursorDiagnosticsEnabled: aiGateway.cursorDiagnosticsEnabled === true,
    wireLogEnabled,
    compactCeiling: aiGateway.compactCeiling ?? null,
    xaiEndpoint: aiGateway.xaiEndpoint ?? DEFAULT_XAI_ENDPOINT_PREFERENCE,
  };
}

/** 키가 없으면 켜진 것으로 읽는다 — 플래그 없는 런치가 이미 하는 일이다. */
export function resolveClaudeCodeSystemPrompt(data: GlobalOptionsData): ClaudeCodeSystemPromptMode {
  return data.claudeCodeSystemPrompt ?? "on";
}

/**
 * 키가 없으면 꺼진 것으로 읽는다 — 승인 게이트를 건너뛰는 것은 사용자가 명시적으로 켠
 * 경우에만 참이어야 하고, 저장된 적 없는 상태가 그 동의를 대신할 수는 없다.
 */
export function resolveClaudeCodeSkipPermissions(data: GlobalOptionsData): boolean {
  return data.claudeCodeSkipPermissions === true;
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
  if (keys[0] === "agentIdleDormantMinutes") {
    return isAgentIdleDormantMinutes(body.agentIdleDormantMinutes)
      ? { agentIdleDormantMinutes: body.agentIdleDormantMinutes }
      : null;
  }
  if (keys[0] === "claudeCodeSkipPermissions") {
    return typeof body.claudeCodeSkipPermissions === "boolean"
      ? { claudeCodeSkipPermissions: body.claudeCodeSkipPermissions }
      : null;
  }
  if (keys[0] === "claudeCodeSystemPrompt") {
    return body.claudeCodeSystemPrompt === "on" || body.claudeCodeSystemPrompt === "off"
      ? { claudeCodeSystemPrompt: body.claudeCodeSystemPrompt }
      : null;
  }
  if (keys[0] === "aiGateway") {
    const parsed = parseAiGatewayUpdate(body.aiGateway);
    return parsed.ok ? { aiGateway: parsed.value } : null;
  }
  if (keys[0] === "cursorDiagnosticsEnabled") {
    return typeof body.cursorDiagnosticsEnabled === "boolean"
      ? { cursorDiagnosticsEnabled: body.cursorDiagnosticsEnabled }
      : null;
  }
  if (keys[0] === "wireLogEnabled") {
    return typeof body.wireLogEnabled === "boolean"
      ? { wireLogEnabled: body.wireLogEnabled }
      : null;
  }
  if (keys[0] === "compactCeiling") {
    if (body.compactCeiling === null) return { compactCeiling: undefined };
    const ceiling = normalizeCompactCeiling(body.compactCeiling);
    return ceiling === undefined ? null : { compactCeiling: ceiling };
  }
  if (keys[0] === "xaiEndpoint") {
    return typeof body.xaiEndpoint === "string"
      && XAI_ENDPOINT_PREFERENCES.includes(body.xaiEndpoint as XaiEndpointPreference)
      ? { xaiEndpoint: body.xaiEndpoint as XaiEndpointPreference }
      : null;
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
