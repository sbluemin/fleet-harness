import { ApiError } from "./api.js";
import type { GlobalSettingsMutationResult, GlobalSettingsState } from "./types.js";

export async function fetchGlobalSettingsState(signal?: AbortSignal): Promise<GlobalSettingsState> {
  const response = await fetch("/global-settings/state", { signal });
  await assertOk(response);
  return assertGlobalSettingsState(await response.json(), response.status);
}

export async function updateGlobalSettings(patch: Partial<GlobalSettingsState>, signal?: AbortSignal): Promise<GlobalSettingsMutationResult> {
  const response = await fetch("/global-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
    signal,
  });
  await assertOk(response);
  const payload = await response.json() as { readonly state?: unknown };
  if (!payload || typeof payload !== "object" || !("state" in payload)) {
    throw new ApiError(response.status, "Invalid global settings mutation response");
  }
  return { state: assertGlobalSettingsState(payload.state, response.status) };
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  let message = response.statusText || `HTTP ${response.status}`;
  try {
    const payload = await response.json() as { error?: unknown };
    if (typeof payload.error === "string") message = payload.error;
  } catch {
    // 응답 본문이 JSON이 아니면 statusText를 사용한다.
  }
  throw new ApiError(response.status, message);
}

function assertGlobalSettingsState(value: unknown, status: number): GlobalSettingsState {
  const payload = value as Partial<GlobalSettingsState>;
  if (
    !payload
    || typeof payload.replaceSystemPrompt !== "boolean"
    || typeof payload.enableMetaphor !== "boolean"
    || (payload.consolePortMode !== "dynamic" && payload.consolePortMode !== "static")
    || (payload.consoleStaticPort !== null && !isValidConsoleStaticPort(payload.consoleStaticPort))
  ) {
    throw new ApiError(status, "Invalid global settings state response");
  }
  return {
    replaceSystemPrompt: payload.replaceSystemPrompt,
    enableMetaphor: payload.enableMetaphor,
    consolePortMode: payload.consolePortMode,
    consoleStaticPort: payload.consoleStaticPort,
  };
}

function isValidConsoleStaticPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535;
}
