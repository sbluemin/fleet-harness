import {
  BROWSER_PASSWORD_MAX_ENTRIES,
  BROWSER_PASSWORD_MAX_NEVER_ORIGINS,
  BROWSER_PASSWORD_ORIGIN_MAX_LENGTH,
  BROWSER_PASSWORD_SECRET_MAX_LENGTH,
  BROWSER_PASSWORD_USERNAME_MAX_LENGTH,
  normalizeBrowserPasswordOrigin,
  type BrowserPasswordErrorCode,
  type BrowserPasswordShellCommand,
  type BrowserPasswordSummary,
  type BrowserPasswordVaultState,
  type BrowserPasswordVaultUnavailableReason,
} from "@fleet-console/protocol/desktop/browser-passwords";
import { CdpError } from "./cdp.js";

/**
 * 관리 Desktop 비밀번호 금고의 Console 쪽 경계.
 * 라우트는 여기서 거른 값만 JSON 으로 쓴다. `reveal` 이외의 결과에는 비밀번호 원문이 남지 않는다.
 */

const HTTP_STATUS = {
  os_auth_cancelled: 403,
  os_auth_unavailable: 503,
  os_auth_failed: 403,
  encryption_unavailable: 503,
  desktop_required: 409,
  vault_corrupted: 409,
  password_not_found: 404,
  invalid_password_entry: 400,
  vault_limit_reached: 409,
} as const satisfies Record<BrowserPasswordErrorCode, number>;

const ERROR_MESSAGE: Record<BrowserPasswordErrorCode, string> = {
  os_auth_cancelled: "OS authentication was cancelled.",
  os_auth_unavailable: "OS authentication is unavailable.",
  os_auth_failed: "OS authentication failed.",
  encryption_unavailable: "Password encryption is unavailable.",
  desktop_required: "Fleet Desktop is required to manage saved passwords.",
  vault_corrupted: "The password vault could not be read.",
  password_not_found: "That saved password was not found.",
  invalid_password_entry: "That password entry is not valid.",
  vault_limit_reached: "The password vault is full.",
};

export class BrowserPasswordRequestError extends Error {
  constructor(readonly code: BrowserPasswordErrorCode | "browser_request_failed") {
    super(code === "browser_request_failed" ? "The password vault request failed." : ERROR_MESSAGE[code]);
    this.name = "BrowserPasswordRequestError";
  }
}

export function browserPasswordHttpError(error: unknown): { status: number; body: { error: string; message: string } } {
  if (error instanceof BrowserPasswordRequestError && error.code !== "browser_request_failed") {
    return { status: HTTP_STATUS[error.code], body: { error: error.code, message: ERROR_MESSAGE[error.code] } };
  }
  return { status: 500, body: { error: "browser_request_failed", message: "The password vault request failed." } };
}

export function browserPasswordDispatchError(error: unknown): BrowserPasswordRequestError {
  if (error instanceof BrowserPasswordRequestError) return error;
  if (error instanceof CdpError) {
    const detail = error.message.startsWith(`${error.method}: `) ? error.message.slice(error.method.length + 2) : error.message;
    if (isBrowserPasswordErrorCode(detail)) return new BrowserPasswordRequestError(detail);
    if (detail === "desktop_browser_disconnected") return new BrowserPasswordRequestError("desktop_required");
  }
  return new BrowserPasswordRequestError("browser_request_failed");
}

export type BrowserPasswordDispatchResult =
  | { readonly kind: "state"; readonly body: BrowserPasswordVaultState }
  | { readonly kind: "reveal"; readonly body: { readonly password: string } }
  | { readonly kind: "copy"; readonly body: { readonly copied: true } }
  | { readonly kind: "save"; readonly body: { readonly entry: BrowserPasswordSummary; readonly created: boolean } }
  | { readonly kind: "update"; readonly body: { readonly entry: BrowserPasswordSummary } }
  | { readonly kind: "delete"; readonly body: { readonly deleted: boolean } }
  | { readonly kind: "offer"; readonly body: { readonly offerToSave: boolean } }
  | { readonly kind: "never"; readonly body: { readonly neverSaveOrigins: readonly string[] } };

export function acceptBrowserPasswordResult(command: BrowserPasswordShellCommand, raw: unknown): BrowserPasswordDispatchResult {
  const embedded = embeddedPasswordError(raw);
  if (embedded) throw new BrowserPasswordRequestError(embedded);
  switch (command.action) {
    case "state": {
      const body = sanitizeState(raw);
      if (!body) throw new BrowserPasswordRequestError("browser_request_failed");
      return { kind: "state", body };
    }
    case "reveal": {
      const password = revealPassword(raw);
      if (password === null) throw new BrowserPasswordRequestError("browser_request_failed");
      return { kind: "reveal", body: { password } };
    }
    case "copy":
      return { kind: "copy", body: { copied: true } };
    case "save":
    case "update": {
      const entry = summaryOf(raw, "entry");
      if (!entry) throw new BrowserPasswordRequestError("browser_request_failed");
      if (command.action === "save") {
        const created = record(raw)?.created;
        if (typeof created !== "boolean") throw new BrowserPasswordRequestError("browser_request_failed");
        return { kind: "save", body: { entry, created } };
      }
      return { kind: "update", body: { entry } };
    }
    case "delete": {
      const deleted = record(raw)?.deleted;
      if (typeof deleted !== "boolean") throw new BrowserPasswordRequestError("browser_request_failed");
      return { kind: "delete", body: { deleted } };
    }
    case "set-offer-to-save": {
      const offerToSave = record(raw)?.offerToSave;
      if (typeof offerToSave !== "boolean") throw new BrowserPasswordRequestError("browser_request_failed");
      return { kind: "offer", body: { offerToSave } };
    }
    case "add-never-save":
    case "remove-never-save": {
      const neverSaveOrigins = neverOrigins(record(raw)?.neverSaveOrigins);
      if (!neverSaveOrigins) throw new BrowserPasswordRequestError("browser_request_failed");
      return { kind: "never", body: { neverSaveOrigins } };
    }
    default:
      return assertNever(command);
  }
}

export function browserPasswordId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (id.length < 1 || id.length > 128 || /[\u0000-\u001f\u007f\s]/u.test(id)) return null;
  return id;
}

export function browserPasswordUsername(value: unknown): string | null {
  if (typeof value !== "string" || value.length > BROWSER_PASSWORD_USERNAME_MAX_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  return value;
}

/** 원문은 앞뒤 공백을 자르지 않는다. 빈 값과 한도를 넘는 값만 거절한다. */
export function browserPasswordSecret(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > BROWSER_PASSWORD_SECRET_MAX_LENGTH) return null;
  return value;
}

export function browserPasswordOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  const origin = normalizeBrowserPasswordOrigin(value);
  if (!origin || origin.length > BROWSER_PASSWORD_ORIGIN_MAX_LENGTH) return null;
  return origin;
}

function isBrowserPasswordErrorCode(value: string): value is BrowserPasswordErrorCode {
  return Object.prototype.hasOwnProperty.call(HTTP_STATUS, value);
}

function embeddedPasswordError(raw: unknown): BrowserPasswordErrorCode | null {
  const code = record(raw)?.error;
  return typeof code === "string" && isBrowserPasswordErrorCode(code) ? code : null;
}

function sanitizeState(raw: unknown): BrowserPasswordVaultState | null {
  const body = record(raw);
  if (!body) return null;
  const entries: BrowserPasswordSummary[] = [];
  if (body.entries !== undefined) {
    if (!Array.isArray(body.entries)) return null;
    for (const item of body.entries) {
      const entry = asSummary(item);
      if (!entry) continue;
      entries.push(entry);
      if (entries.length >= BROWSER_PASSWORD_MAX_ENTRIES) break;
    }
  }
  const neverSaveOrigins = neverOrigins(body.neverSaveOrigins ?? []);
  if (!neverSaveOrigins) return null;
  const reason = unavailableReason(body.reason);
  return {
    available: body.available === true,
    reason: body.available === true ? null : reason,
    offerToSave: body.offerToSave === true,
    osAuthSupported: body.osAuthSupported === true,
    entries,
    neverSaveOrigins,
  };
}

function summaryOf(raw: unknown, key: string): BrowserPasswordSummary | null {
  return asSummary(record(raw)?.[key]);
}

function asSummary(value: unknown): BrowserPasswordSummary | null {
  const entry = record(value);
  if (!entry) return null;
  const id = browserPasswordId(entry.id);
  const origin = browserPasswordOrigin(entry.origin);
  const username = browserPasswordUsername(entry.username);
  if (!id || !origin || username === null) return null;
  if (typeof entry.createdAt !== "number" || !Number.isFinite(entry.createdAt)) return null;
  if (typeof entry.updatedAt !== "number" || !Number.isFinite(entry.updatedAt)) return null;
  return { id, origin, username, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
}

function revealPassword(raw: unknown): string | null {
  return browserPasswordSecret(record(raw)?.password);
}

function neverOrigins(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const origins: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const origin = browserPasswordOrigin(item);
    if (!origin || origins.includes(origin)) continue;
    origins.push(origin);
    if (origins.length >= BROWSER_PASSWORD_MAX_NEVER_ORIGINS) break;
  }
  return origins;
}

function unavailableReason(value: unknown): BrowserPasswordVaultUnavailableReason | null {
  if (value === "encryption_unavailable" || value === "desktop_required" || value === "vault_corrupted") return value;
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function assertNever(_value: never): never {
  throw new BrowserPasswordRequestError("browser_request_failed");
}
