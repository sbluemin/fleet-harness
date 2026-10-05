import type { FleetPluginHostCapabilities, ApiCatalogEntry } from "@fleet-console/sdk/plugin";
import type { RouteHandler } from "@fleet-console/sdk/routing";

interface ExecutionSettingsContext {
  readonly host: {
    readonly http: Pick<FleetPluginHostCapabilities["http"], "readJsonBody" | "writeJson">;
    readonly security: Pick<FleetPluginHostCapabilities["security"], "isTerminalAuthorized">;
  };
  registerRouter(path: string, handler: RouteHandler, catalog?: ApiCatalogEntry | readonly ApiCatalogEntry[]): void;
}
import type http from "node:http";
import type { TheaterSystemPromptService } from "./agent-options.js";

import {
  MAX_CLAUDE_CODE_CUSTOM_SYSTEM_PROMPT_CHARS,
  sanitizeClaudeCodeCustomSystemPrompt,
  type ClaudeCodeTheaterSystemPrompt,
  type AgentOptionsData,
  type AgentOptionsService,
} from "@fleet-console/infra";

import {
  buildAiGatewayCatalog,
  findClaudeGatewayModel,
  normalizeCompactCeiling,
  parseAiGatewayUpdate,
  DEFAULT_XAI_ENDPOINT_PREFERENCE,
  DELEGATION_ROUTING_MODES,
  XAI_ENDPOINT_PREFERENCES,
  type AiGatewayCatalog,
  type DelegationRoutingMode,
  type AiGatewaySettingsStore,
  type AiGatewayStoredSettings,
  type AiGatewayUpdateValue,
  type CompactCeiling,
  type XaiEndpointPreference,
} from "@fleet-console/ai-gateway";

interface TerminalSettingsRouteDeps {
  readonly agentOptionsService: AgentOptionsService;
  readonly theaterSystemPrompts: TheaterSystemPromptService;
  readonly aiGatewayStore: AiGatewaySettingsStore;
  /** Resolves Claude alias entries to the installed CLI's versions before the catalog is shown. */
  readonly ensureClaudeNativeModels?: () => Promise<void>;
  readonly wireLogRuntime: {
    readonly enabled: () => boolean;
    readonly apply: (stored: boolean | undefined) => void;
  };
  /** AI Gateway 설정을 쓴 직후. 모델 로스터가 그 파일에서 투영되므로 열린 화면에 다시 읽으라고 알린다. */
  readonly onAiGatewayChanged?: () => void;
}

interface TerminalSettingsBody {
  readonly agentIdleDormantMinutes?: unknown;
  readonly aiGateway?: unknown;
  readonly wireLogEnabled?: unknown;
  readonly delegationRoutingEnabled?: unknown;
  readonly delegationRoutingMode?: unknown;
  readonly delegationRoutingModel?: unknown;
  readonly compactCeiling?: unknown;
  readonly xaiEndpoint?: unknown;
}

type TerminalSettingsUpdate =
  | { readonly agentIdleDormantMinutes: number | null }
  | { readonly aiGateway: AiGatewayUpdateValue | undefined }
  | { readonly wireLogEnabled: boolean }
  | { readonly delegationRoutingEnabled: boolean }
  | { readonly delegationRoutingMode: DelegationRoutingMode }
  | { readonly delegationRoutingModel: string | null }
  | { readonly compactCeiling: CompactCeiling | undefined }
  | { readonly xaiEndpoint: XaiEndpointPreference };

const DEFAULT_AGENT_IDLE_DORMANT_MINUTES = 60;

export interface TerminalSettingsState {
  readonly agentIdleDormantMinutes: number | null;
  readonly aiGateway: AiGatewayUpdateValue | null;
  readonly aiGatewayCatalog: AiGatewayCatalog;
  readonly wireLogEnabled: boolean;
  /** AI 판단 활성화 여부. Off는 로컬 규칙 기반 fallback을 사용한다. */
  readonly delegationRoutingEnabled: boolean;
  /** 활성화했을 때 사용할 AI 판단 방식. */
  readonly delegationRoutingMode: DelegationRoutingMode;
  readonly delegationRoutingModel: string | null;
  readonly compactCeiling: CompactCeiling | null;
  readonly xaiEndpoint: XaiEndpointPreference;
}

const CLAUDE_CATALOG_WAIT_MS = 5_000;

export function registerTerminalSettingsRoutes(ctx: ExecutionSettingsContext, deps: TerminalSettingsRouteDeps): void {
  ctx.registerRouter("agent/settings", async ({ req, res }) => {
    if (req.method === "GET") {
      // 첫 조회만 CLI를 띄운다. 느리면 기다리지 않고 지금 아는 표로 그린다.
      if (deps.ensureClaudeNativeModels) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          deps.ensureClaudeNativeModels(),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, CLAUDE_CATALOG_WAIT_MS); }),
        ]);
        clearTimeout(timer);
      }
      // 세션 없는 요청은 상류가 이미 걷어냈다. 다만 상류가 보장하는 것은 loopback이 아니다 —
      // 원격 리스너에서 온 GET도 여기 닿고, 원격 세션은 이 콘솔의 설정 화면을 그리는 주체이므로
      // 그래야 한다. 플러그인 컨텍스트에는 콘솔 포트가 없어 여기서 Host를 다시 볼 수도 없다.
      ctx.host.http.writeJson(res, 200, toTerminalSettingsState(
        deps.agentOptionsService.load(),
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
        deps.onAiGatewayChanged?.();
        ctx.host.http.writeJson(res, 200, toTerminalSettingsState(
          deps.agentOptionsService.load(), stored, deps.wireLogRuntime.enabled(),
        ));
        return true;
      }
      if ("delegationRoutingEnabled" in update) {
        const stored = deps.aiGatewayStore.writeDelegationRoutingEnabled(update.delegationRoutingEnabled);
        ctx.host.http.writeJson(res, 200, toTerminalSettingsState(
          deps.agentOptionsService.load(), stored, deps.wireLogRuntime.enabled(),
        ));
        return true;
      }
      if ("delegationRoutingModel" in update) {
        const stored = deps.aiGatewayStore.writeDelegationRoutingModel(update.delegationRoutingModel ?? undefined);
        ctx.host.http.writeJson(res, 200, toTerminalSettingsState(deps.agentOptionsService.load(), stored, deps.wireLogRuntime.enabled()));
        return true;
      }
      if ("delegationRoutingMode" in update) {
        const stored = deps.aiGatewayStore.writeDelegationRoutingMode(update.delegationRoutingMode);
        ctx.host.http.writeJson(res, 200, toTerminalSettingsState(
          deps.agentOptionsService.load(), stored, deps.wireLogRuntime.enabled(),
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
          deps.agentOptionsService.load(), stored, deps.wireLogRuntime.enabled(),
        ));
        return true;
      }
      if ("compactCeiling" in update) {
        const stored = deps.aiGatewayStore.writeCompactCeiling(update.compactCeiling);
        ctx.host.http.writeJson(res, 200, toTerminalSettingsState(
          deps.agentOptionsService.load(), stored, deps.wireLogRuntime.enabled(),
        ));
        return true;
      }
      if ("xaiEndpoint" in update) {
        const stored = deps.aiGatewayStore.writeXaiEndpoint(update.xaiEndpoint);
        ctx.host.http.writeJson(res, 200, toTerminalSettingsState(
          deps.agentOptionsService.load(), stored, deps.wireLogRuntime.enabled(),
        ));
        return true;
      }
      const updated = deps.agentOptionsService.update((current) => {
        return { ...current, ...update };
      });
      ctx.host.http.writeJson(res, 200, toTerminalSettingsState(
        updated, deps.aiGatewayStore.read(), deps.wireLogRuntime.enabled(),
      ));
      return true;
    }
    ctx.host.http.writeJson(res, 405, { error: "Method not allowed" });
    return true;
  }, [
    { method: "GET", path: "", summary: "Read Terminal plugin settings.", category: "Console Execution", gate: "loopback", transport: "http" },
    { method: "PUT", path: "", summary: "Save Terminal plugin settings.", category: "Console Execution", gate: "origin-write", transport: "http" },
  ]);

  ctx.registerRouter("agent/theater-system-prompt", async ({ req, res }) => {
    if (req.method !== "GET" && req.method !== "PUT") {
      ctx.host.http.writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (req.method === "PUT" && !ctx.host.security.isTerminalAuthorized(req)) {
      ctx.host.http.writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const theaterId = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("theaterId");
    if (!theaterId || !deps.theaterSystemPrompts.exists(theaterId)) {
      ctx.host.http.writeJson(res, 404, { error: "theater_not_found" });
      return true;
    }
    if (req.method === "GET") {
      ctx.host.http.writeJson(res, 200, { theaterId, prompt: deps.theaterSystemPrompts.read(theaterId) });
      return true;
    }
    if (!isJsonRequest(req)) {
      ctx.host.http.writeJson(res, 415, { error: "unsupported_media_type" });
      return true;
    }
    const body = await ctx.host.http.readJsonBody<unknown>(req);
    const prompt = parseTheaterSystemPromptUpdate(body);
    if (prompt === undefined) {
      ctx.host.http.writeJson(res, 400, { error: "invalid_theater_system_prompt" });
      return true;
    }
    // readJsonBody yields: the Theater may have been forgotten while the body was arriving.
    if (!deps.theaterSystemPrompts.exists(theaterId)) {
      ctx.host.http.writeJson(res, 404, { error: "theater_not_found" });
      return true;
    }
    const saved = deps.theaterSystemPrompts.save(theaterId, prompt);
    ctx.host.http.writeJson(res, 200, { theaterId, prompt: saved });
    return true;
  }, [
    { method: "GET", path: "", summary: "Read a registered Theater's Claude Code system prompt.", category: "Console Execution", gate: "loopback", transport: "http" },
    { method: "PUT", path: "", summary: "Save or clear a registered Theater's Claude Code system prompt.", category: "Console Execution", gate: "origin-write", transport: "http" },
  ]);

  // Theater별 서브에이전트 — 기본은 대체(키 없음)이고, 켜 둔 Theater만 서브에이전트를 그대로 쓴다.
  // 판단은 호출마다 읽으므로 떠 있는 세션도 다음 서브에이전트 호출부터 바뀐 값을 따른다.
  ctx.registerRouter("agent/theater-subagents", async ({ req, res }) => {
    if (req.method !== "GET" && req.method !== "PUT") {
      ctx.host.http.writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (req.method === "PUT" && !ctx.host.security.isTerminalAuthorized(req)) {
      ctx.host.http.writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const theaterId = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("theaterId");
    if (!theaterId || !deps.theaterSystemPrompts.exists(theaterId)) {
      ctx.host.http.writeJson(res, 404, { error: "theater_not_found" });
      return true;
    }
    if (req.method === "GET") {
      ctx.host.http.writeJson(res, 200, { theaterId, subagentsKept: deps.theaterSystemPrompts.subagentsKept(theaterId) });
      return true;
    }
    if (!isJsonRequest(req)) {
      ctx.host.http.writeJson(res, 415, { error: "unsupported_media_type" });
      return true;
    }
    const body = await ctx.host.http.readJsonBody<unknown>(req);
    const kept = body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 1 ? (body as { subagentsKept?: unknown }).subagentsKept : undefined;
    if (typeof kept !== "boolean") {
      ctx.host.http.writeJson(res, 400, { error: "invalid_theater_subagents" });
      return true;
    }
    // readJsonBody yields: the Theater may have been forgotten while the body was arriving.
    if (!deps.theaterSystemPrompts.exists(theaterId)) {
      ctx.host.http.writeJson(res, 404, { error: "theater_not_found" });
      return true;
    }
    ctx.host.http.writeJson(res, 200, { theaterId, subagentsKept: deps.theaterSystemPrompts.keepSubagents(theaterId, kept) });
    return true;
  }, [
    { method: "GET", path: "", summary: "Read whether a registered Theater keeps Claude Code subagents.", category: "Console Execution", gate: "loopback", transport: "http" },
    { method: "PUT", path: "", summary: "Choose whether a registered Theater keeps Claude Code subagents.", category: "Console Execution", gate: "origin-write", transport: "http" },
  ]);
}

function parseTheaterSystemPromptUpdate(body: unknown): ClaudeCodeTheaterSystemPrompt | null | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !("prompt" in body)) return undefined;
  const prompt = body.prompt;
  if (prompt === null) return null;
  if (!prompt || typeof prompt !== "object" || Array.isArray(prompt) || Object.keys(prompt).length !== 2) return undefined;
  if (!("mode" in prompt) || !("body" in prompt)) return undefined;
  if (prompt.mode !== "on" && prompt.mode !== "append" && prompt.mode !== "off") return undefined;
  if (typeof prompt.body !== "string" || prompt.body.length > MAX_CLAUDE_CODE_CUSTOM_SYSTEM_PROMPT_CHARS) return undefined;
  return { mode: prompt.mode, body: sanitizeClaudeCodeCustomSystemPrompt(prompt.body) ?? "" };
}

function toTerminalSettingsState(
  data: AgentOptionsData,
  aiGateway: AiGatewayStoredSettings,
  wireLogEnabled: boolean,
): TerminalSettingsState {
  const configured = (aiGateway.models?.length ?? 0) > 0
    || (aiGateway.providerPriority?.length ?? 0) > 0;
  return {
    agentIdleDormantMinutes: data.agentIdleDormantMinutes === undefined
      ? DEFAULT_AGENT_IDLE_DORMANT_MINUTES
      : data.agentIdleDormantMinutes,
    aiGateway: configured
      ? {
        ...(aiGateway.models?.length ? { models: aiGateway.models } : {}),
        ...(aiGateway.providerPriority?.length ? { providerPriority: aiGateway.providerPriority } : {}),
      }
      : null,
    aiGatewayCatalog: buildAiGatewayCatalog(),
    wireLogEnabled,
    delegationRoutingEnabled: aiGateway.delegationRoutingEnabled === true,
    delegationRoutingModel: aiGateway.delegationRoutingModel ?? null,
    delegationRoutingMode: aiGateway.delegationRoutingMode ?? "model",
    compactCeiling: aiGateway.compactCeiling ?? null,
    xaiEndpoint: aiGateway.xaiEndpoint ?? DEFAULT_XAI_ENDPOINT_PREFERENCE,
  };
}

export function resolveAgentIdleDormantMinutes(data: AgentOptionsData): number | null {
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
  if (keys[0] === "aiGateway") {
    const parsed = parseAiGatewayUpdate(body.aiGateway);
    return parsed.ok ? { aiGateway: parsed.value } : null;
  }
  if (keys[0] === "delegationRoutingEnabled") {
    return typeof body.delegationRoutingEnabled === "boolean"
      ? { delegationRoutingEnabled: body.delegationRoutingEnabled }
      : null;
  }
  if (keys[0] === "delegationRoutingModel") {
    return body.delegationRoutingModel === null || (typeof body.delegationRoutingModel === "string" && findClaudeGatewayModel(body.delegationRoutingModel))
      ? { delegationRoutingModel: body.delegationRoutingModel as string | null } : null;
  }
  if (keys[0] === "delegationRoutingMode") {
    return typeof body.delegationRoutingMode === "string"
      && DELEGATION_ROUTING_MODES.includes(body.delegationRoutingMode as DelegationRoutingMode)
      ? { delegationRoutingMode: body.delegationRoutingMode as DelegationRoutingMode }
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
