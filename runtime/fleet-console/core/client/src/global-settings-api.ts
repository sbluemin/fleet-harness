import { resolveExperimentSettings } from "@fleet-console/sdk/settings/browser";
import { ApiError } from "./api.js";
import { normalizeUiFont } from "./ui-font.js";
import { REMOTE_AUTO_PORT_MAX, REMOTE_AUTO_PORT_MIN, REMOTE_PORT_MAX, REMOTE_PORT_MIN, isValidRemoteAccessAcknowledgment, isValidRemoteAccessId, isValidRemoteAccessPort, isValidRemoteAccessState, isValidRemoteFingerprint, isValidRemoteTimestamp, type ConsoleLanguagePreference, type GlobalSettingsMutationResult, type GlobalSettingsState, type RemoteAccessClass, type RemoteAccessInterface, type RemoteAccessLink, type RemoteAccessLinkSummary, type RemoteAccessPairedDevice, type RemoteAccessStatus } from "./types.js";

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
  const payload = await response.json();
  if (!isRemoteAccessStatus(payload)) throw new ApiError(response.status, "Invalid remote access status response");
  return payload;
}

export async function revokeRemoteAccessLink(id: string, signal?: AbortSignal): Promise<void> {
  await assertRevoked(await fetch(`/api/v1/access-links/${encodeURIComponent(id)}`, { method: "DELETE", signal }));
}

/** 지금 붙어 있는 접속만 끊는다. 그 기기는 여전히 페어링되어 있어 스스로 다시 붙을 수 있다. */
export async function revokeRemoteAccessSession(handle: string, signal?: AbortSignal): Promise<void> {
  await assertRevoked(await fetch(`/api/v1/access-sessions/${encodeURIComponent(handle)}`, { method: "DELETE", signal }));
}

/** 페어링을 거둔다. 새 액세스 링크 없이는 다시 붙지 못한다. */
export async function revokeRemoteAccessDevice(id: string, signal?: AbortSignal): Promise<void> {
  await assertRevoked(await fetch(`/api/v1/paired-devices/${encodeURIComponent(id)}`, { method: "DELETE", signal }));
}

/**
 * 이미 사라진 자격의 회수는 실패가 아니다 — 목록이 낡았을 뿐이고, 사용자가 원한 상태는
 * 이미 참이다. 404를 오류로 띄우면 "안 없어졌다"는 반대 인상을 준다.
 */
async function assertRevoked(response: Response): Promise<void> {
  if (response.status === 404) return;
  await assertOk(response);
}

export async function rotateRemoteIdentity(signal?: AbortSignal): Promise<void> {
  await assertOk(await fetch("/api/v1/remote-identity/rotations", { method: "POST", signal }));
}

function isLinkSummary(value: unknown): value is RemoteAccessLinkSummary {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<RemoteAccessLinkSummary>;
  return isValidRemoteAccessId(entry.id) && (entry.access === "full" || entry.access === "monitoring")
    && isValidRemoteTimestamp(entry.issuedAt)
    && isValidRemoteTimestamp(entry.expiresAt)
    && entry.expiresAt > entry.issuedAt;
}

function isInterfaceCandidate(value: unknown): value is RemoteAccessInterface {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<RemoteAccessInterface>;
  return (entry.kind === "tailscale" || entry.kind === "local") && typeof entry.label === "string" && typeof entry.address === "string";
}

function isPairedDevice(value: unknown): value is RemoteAccessPairedDevice {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<RemoteAccessPairedDevice>;
  return isValidRemoteAccessId(entry.id) && (entry.device === null || typeof entry.device === "string")
    && (entry.access === "full" || entry.access === "monitoring")
    && isValidRemoteTimestamp(entry.pairedAt)
    && isValidRemoteTimestamp(entry.lastSeenAt)
    && (entry.sessionHandle === null || isValidRemoteAccessId(entry.sessionHandle));
}

function isRejectedJoins(value: unknown): value is RemoteAccessStatus["rejectedJoins"] {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<RemoteAccessStatus["rejectedJoins"]>;
  return typeof entry.count === "number" && Number.isInteger(entry.count) && entry.count >= 0
    && (entry.lastAt === null || isValidRemoteTimestamp(entry.lastAt));
}

function isRemoteAccessStatus(value: unknown): value is RemoteAccessStatus {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<RemoteAccessStatus>;
  const listener = entry.listener as Partial<RemoteAccessStatus["listener"]> | null | undefined;
  if (!listener) return false;
  return typeof listener.listening === "boolean"
    && (listener.origin === null || typeof listener.origin === "string")
    && (listener.lastError === null || typeof listener.lastError === "string")
    && entry.publicReachability === "unverified"
    && isRejectedJoins(entry.rejectedJoins)
    && isValidRemoteFingerprint(entry.fingerprint)
    && Array.isArray(entry.links) && entry.links.every(isLinkSummary)
    && Array.isArray(entry.devices) && entry.devices.every(isPairedDevice)
    && Array.isArray(entry.interfaces) && entry.interfaces.every(isInterfaceCandidate);
}

function isRemoteAccessLink(value: unknown): value is RemoteAccessLink {
  if (!value || typeof value !== "object") return false;
  const link = value as Partial<RemoteAccessLink>;
  return isValidRemoteAccessId(link.id) && isNonEmptyString(link.link)
    && (link.access === "full" || link.access === "monitoring")
    && isValidRemoteTimestamp(link.expiresAt)
    && isValidRemoteFingerprint(link.fingerprint) && link.fingerprint !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export async function createRemoteAccessLink(access: RemoteAccessClass, signal?: AbortSignal): Promise<RemoteAccessLink> {
  const response = await fetch(`/api/v1/access-links?access=${access}`, { method: "POST", signal });
  await assertOk(response);
  const payload = await response.json();
  if (!isRemoteAccessLink(payload)) throw new ApiError(response.status, "Invalid remote access link response");
  return payload;
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
    || (payload.remoteAccess !== undefined && !isValidRemoteAccessState(payload.remoteAccess))
  ) {
    throw new ApiError(status, "Invalid global settings state response");
  }
  return {
    consolePortMode: payload.consolePortMode,
    consoleStaticPort: payload.consoleStaticPort,
    ...(payload.remoteAccess === undefined ? {} : { remoteAccess: payload.remoteAccess }),
    seenFeatureTours: payload.seenFeatureTours,
    theme: payload.theme,
    // 구서버 응답에는 필드가 없다 — 기본 옵트인(true)으로 정규화해 화면 계약을 한 형으로 유지한다.
    liquidGlass: payload.liquidGlass !== false,
    // 같은 이유로 구서버 응답에는 세기가 없다 — 기본값으로 정규화한다.
    unfocusedPanelFade: isUnfocusedPanelFade(payload.unfocusedPanelFade) ? payload.unfocusedPanelFade : 50,
    uiFont: normalizeUiFont(payload.uiFont),
    language: payload.language,
    // 구서버 응답에는 없다 — 옵트인의 기본은 꺼짐이므로 부재를 기본값으로 정규화한다.
    experiments: resolveExperimentSettings(payload.experiments),
  };
}

function isUnfocusedPanelFade(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 70;
}

function isValidConsoleStaticPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535;
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
