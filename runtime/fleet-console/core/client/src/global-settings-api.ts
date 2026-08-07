import { ApiError } from "./api.js";
import { normalizeUiFont } from "./ui-font.js";
import type { ConsoleLanguagePreference, GlobalSettingsMutationResult, GlobalSettingsState, RemoteAccessLink, RemoteAccessState, RemoteAccessStatus } from "./types.js";

export async function fetchGlobalSettingsState(signal?: AbortSignal): Promise<GlobalSettingsState> {
  const response = await fetch("/api/v1/settings/global", { signal });
  await assertOk(response);
  return assertGlobalSettingsState(await response.json(), response.status);
}

export async function updateGlobalSettings(patch: Partial<GlobalSettingsState>, signal?: AbortSignal): Promise<GlobalSettingsMutationResult> {
  const response = await fetch("/api/v1/settings/global", {
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

export async function fetchRemoteAccessStatus(signal?: AbortSignal): Promise<RemoteAccessStatus> {
  const response = await fetch("/api/v1/access-links", { signal });
  await assertOk(response);
  const payload = await response.json() as Partial<RemoteAccessStatus>;
  if (typeof payload?.listening !== "boolean") throw new ApiError(response.status, "Invalid remote access status response");
  return {
    listening: payload.listening,
    origin: typeof payload.origin === "string" ? payload.origin : null,
    fingerprint: typeof payload.fingerprint === "string" ? payload.fingerprint : null,
    lastError: typeof payload.lastError === "string" ? payload.lastError : null,
  };
}

export async function createRemoteAccessLink(signal?: AbortSignal): Promise<RemoteAccessLink> {
  const response = await fetch("/api/v1/access-links", { method: "POST", signal });
  await assertOk(response);
  const payload = await response.json() as Partial<RemoteAccessLink>;
  if (typeof payload?.link !== "string" || typeof payload.expiresAt !== "number" || typeof payload.fingerprint !== "string") {
    throw new ApiError(response.status, "Invalid remote access link response");
  }
  return { link: payload.link, expiresAt: payload.expiresAt, fingerprint: payload.fingerprint };
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
    || (payload.consolePortMode !== "dynamic" && payload.consolePortMode !== "static")
    || (payload.consoleStaticPort !== null && !isValidConsoleStaticPort(payload.consoleStaticPort))
    || !isSeenFeatureTours(payload.seenFeatureTours)
    || (payload.theme !== "instrument" && payload.theme !== "maritime" && payload.theme !== "carbon"
      && payload.theme !== "whites")
    || !isConsoleLanguagePreference(payload.language)
    || !isRemoteAccessState(payload.remoteAccess)
  ) {
    throw new ApiError(status, "Invalid global settings state response");
  }
  return {
    consolePortMode: payload.consolePortMode,
    consoleStaticPort: payload.consoleStaticPort,
    remoteAccess: payload.remoteAccess,
    seenFeatureTours: payload.seenFeatureTours,
    theme: payload.theme,
    uiFont: normalizeUiFont(payload.uiFont),
    language: payload.language,
  };
}

function isValidConsoleStaticPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535;
}

function isRemoteAccessState(value: unknown): value is RemoteAccessState {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<RemoteAccessState>;
  return typeof entry.enabled === "boolean" && (entry.bindHost === null || typeof entry.bindHost === "string");
}

function isConsoleLanguagePreference(value: unknown): value is ConsoleLanguagePreference {
  return value === "auto" || value === "en" || value === "ko";
}

function isSeenFeatureTours(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length <= 64
    && value.every((item) => typeof item === "string" && item.length <= 64)
    && new Set(value).size === value.length;
}
