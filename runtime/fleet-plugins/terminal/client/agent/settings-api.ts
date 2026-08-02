export interface AiGatewayModelSelection {
  readonly id: string;
}

export interface AiGatewaySettings {
  readonly models?: readonly AiGatewayModelSelection[];
  readonly defaultModel?: string;
}

export type AiGatewayProviderId = "claude" | "codex" | "cursor" | "kimi";

export interface AiGatewayCatalogModel {
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number | null;
  readonly oneMillion: boolean;
  readonly maxMode: boolean;
  readonly fast: boolean;
  readonly description: string | null;
  readonly effort: { readonly levels: readonly string[] } | null;
}

export interface AiGatewayCatalogProvider {
  readonly id: AiGatewayProviderId;
  readonly models: readonly AiGatewayCatalogModel[];
}

export interface AiGatewayCatalog {
  readonly providers: readonly AiGatewayCatalogProvider[];
}

export interface SystemPromptSettingsState {
  readonly enableMetaphor: boolean;
  readonly agentIdleDormantMinutes: number | null;
  readonly aiGateway: AiGatewaySettings | null;
  readonly aiGatewayCatalog: AiGatewayCatalog;
  readonly cursorDiagnosticsEnabled: boolean;
}

export type SystemPromptSettingsUpdate =
  | { readonly enableMetaphor: boolean }
  | { readonly agentIdleDormantMinutes: number | null }
  | { readonly aiGateway: AiGatewaySettings | null }
  | { readonly cursorDiagnosticsEnabled: boolean };

export class TerminalSettingsApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TerminalSettingsApiError";
    this.status = status;
  }
}

export async function fetchSystemPromptSettings(signal?: AbortSignal): Promise<SystemPromptSettingsState> {
  const response = await fetch("/plugins/terminal/settings", { signal });
  await assertOk(response);
  return assertSystemPromptSettingsState(await response.json(), response.status);
}

export async function saveSystemPromptSettings(settings: SystemPromptSettingsUpdate, signal?: AbortSignal): Promise<SystemPromptSettingsState> {
  const response = await fetch("/plugins/terminal/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
    signal,
  });
  await assertOk(response);
  return assertSystemPromptSettingsState(await response.json(), response.status);
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  let message = response.statusText || `HTTP ${response.status}`;
  try {
    const payload = await response.json() as { readonly error?: unknown };
    if (typeof payload.error === "string") message = payload.error;
  } catch {
    // 응답 본문이 JSON이 아니면 statusText를 사용한다.
  }
  throw new TerminalSettingsApiError(response.status, message);
}

function assertSystemPromptSettingsState(value: unknown, status: number): SystemPromptSettingsState {
  const payload = value as Partial<SystemPromptSettingsState>;
  if (
    !payload
    || typeof payload.enableMetaphor !== "boolean"
    || !isAgentIdleDormantMinutes(payload.agentIdleDormantMinutes)
    || !isAiGatewayCatalog(payload.aiGatewayCatalog)
    || typeof payload.cursorDiagnosticsEnabled !== "boolean"
  ) {
    throw new TerminalSettingsApiError(status, "Invalid Terminal settings response");
  }
  return {
    enableMetaphor: payload.enableMetaphor,
    agentIdleDormantMinutes: payload.agentIdleDormantMinutes,
    aiGateway: payload.aiGateway ?? null,
    aiGatewayCatalog: payload.aiGatewayCatalog,
    cursorDiagnosticsEnabled: payload.cursorDiagnosticsEnabled,
  };
}

function isAiGatewayCatalog(value: unknown): value is AiGatewayCatalog {
  if (!value || typeof value !== "object") return false;
  const providers = (value as AiGatewayCatalog).providers;
  return Array.isArray(providers) && providers.every((provider) =>
    provider && typeof provider.id === "string" && Array.isArray(provider.models));
}

function isAgentIdleDormantMinutes(value: unknown): value is number | null {
  if (value === null) return true;
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}
