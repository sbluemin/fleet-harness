export interface KimiModelSetting {
  readonly model: string;
  readonly effort?: string;
}

export interface SystemPromptSettingsState {
  readonly enableMetaphor: boolean;
  readonly kimiModel: KimiModelSetting | null;
  readonly agentIdleDormantMinutes: number | null;
}

export type SystemPromptSettingsUpdate =
  | { readonly enableMetaphor: boolean }
  | { readonly kimiModel: KimiModelSetting }
  | { readonly agentIdleDormantMinutes: number | null };

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
  ) {
    throw new TerminalSettingsApiError(status, "Invalid Terminal settings response");
  }
  return {
    enableMetaphor: payload.enableMetaphor,
    kimiModel: assertKimiModelSetting(payload.kimiModel),
    agentIdleDormantMinutes: payload.agentIdleDormantMinutes,
  };
}

function isAgentIdleDormantMinutes(value: unknown): value is number | null {
  if (value === null) return true;
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

// kimiModel은 선택 필드다. null/부재는 null로, 형태가 깨진 값은 서버 계약 위반이지만
// 읽기 경로에서는 설정 미저장과 동일하게 null로 폴백한다.
function assertKimiModelSetting(value: unknown): KimiModelSetting | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { model?: unknown; effort?: unknown };
  if (typeof record.model !== "string" || record.model.length === 0) return null;
  return {
    model: record.model,
    ...(typeof record.effort === "string" ? { effort: record.effort } : {}),
  };
}
