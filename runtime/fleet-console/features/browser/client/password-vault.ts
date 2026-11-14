import { normalizeBrowserPasswordOrigin } from "@fleet-console/protocol/desktop/browser-passwords";

/** 설정 화면이 다루는 비밀번호 메타데이터. 원문은 여기 담지 않는다. */
export interface SavedPassword {
  readonly id: string;
  readonly origin: string;
  readonly username: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PasswordVaultView {
  readonly available: boolean;
  readonly reason: string | null;
  readonly offerToSave: boolean;
  readonly osAuthSupported: boolean;
  readonly entries: readonly SavedPassword[];
  readonly neverSaveOrigins: readonly string[];
}

export class PasswordVaultError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "PasswordVaultError";
    this.code = code;
  }
}

const ROOT = "/api/v1/browser/passwords";

export async function loadPasswordVault(): Promise<PasswordVaultView> {
  return asVault(await send("GET", ROOT));
}

export async function savePasswordOffer(enabled: boolean): Promise<boolean> {
  const body = await send("POST", `${ROOT}/settings`, { enabled });
  return record(body)?.offerToSave === true;
}

/** 호출한 쪽이 화면을 떠날 때 이 문자열을 버려야 한다. 이 모듈은 보관하지 않는다. */
export async function revealSavedPassword(id: string): Promise<string> {
  const body = await send("POST", `${ROOT}/reveal`, { id });
  const password = record(body)?.password;
  if (typeof password !== "string" || password.length === 0) throw new PasswordVaultError("browser_request_failed");
  return password;
}

export async function copySavedPassword(id: string): Promise<void> {
  await send("POST", `${ROOT}/copy`, { id });
}

export async function saveSavedPassword(input: { readonly origin: string; readonly username: string; readonly password: string }): Promise<void> {
  await send("POST", `${ROOT}/save`, input);
}

export async function updateSavedPassword(input: { readonly id: string; readonly username: string; readonly origin?: string; readonly password?: string }): Promise<void> {
  await send("POST", `${ROOT}/update`, input);
}

export async function deleteSavedPassword(id: string): Promise<void> {
  await send("POST", `${ROOT}/delete`, { id });
}

export async function removeNeverSaveOrigin(origin: string): Promise<readonly string[]> {
  const body = await send("DELETE", `${ROOT}/never-save`, { origin });
  const origins = record(body)?.neverSaveOrigins;
  return Array.isArray(origins) ? origins.filter((item): item is string => typeof item === "string") : [];
}

export function filterSavedPasswords(entries: readonly SavedPassword[], query: string): readonly SavedPassword[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) => entry.origin.toLowerCase().includes(needle) || entry.username.toLowerCase().includes(needle));
}

/** 사람이 적은 사이트 주소를 금고가 받는 출처로 고친다. 스킴이 없으면 https 로 본다. */
export function passwordOriginDraft(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const direct = normalizeBrowserPasswordOrigin(trimmed);
  if (direct) return direct;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  return normalizeBrowserPasswordOrigin(`https://${trimmed}`);
}

async function send(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method,
    cache: "no-store",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = record(data)?.error;
    throw new PasswordVaultError(typeof code === "string" && code.length > 0 ? code : "browser_request_failed");
  }
  return data;
}

function asVault(value: unknown): PasswordVaultView {
  const body = record(value);
  if (!body) throw new PasswordVaultError("browser_request_failed");
  const entries = Array.isArray(body.entries) ? body.entries.flatMap((item) => { const entry = asEntry(item); return entry ? [entry] : []; }) : [];
  const neverSaveOrigins = Array.isArray(body.neverSaveOrigins) ? body.neverSaveOrigins.filter((item): item is string => typeof item === "string") : [];
  return {
    available: body.available === true,
    reason: typeof body.reason === "string" ? body.reason : null,
    offerToSave: body.offerToSave === true,
    osAuthSupported: body.osAuthSupported === true,
    entries,
    neverSaveOrigins,
  };
}

function asEntry(value: unknown): SavedPassword | null {
  const entry = record(value);
  if (!entry || typeof entry.id !== "string" || typeof entry.origin !== "string" || typeof entry.username !== "string") return null;
  if (typeof entry.createdAt !== "number" || typeof entry.updatedAt !== "number") return null;
  return { id: entry.id, origin: entry.origin, username: entry.username, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}
