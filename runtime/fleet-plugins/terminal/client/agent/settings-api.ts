export interface SystemPromptSettingsState {
  readonly enableMetaphor: boolean;
}

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

export async function saveSystemPromptSettings(settings: SystemPromptSettingsState, signal?: AbortSignal): Promise<SystemPromptSettingsState> {
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
  ) {
    throw new TerminalSettingsApiError(status, "Invalid Terminal settings response");
  }
  return {
    enableMetaphor: payload.enableMetaphor,
  };
}
