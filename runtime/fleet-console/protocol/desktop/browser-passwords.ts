/**
 * 창을 든 Desktop 의 safeStorage 비밀번호 금고와 Console 사이의 공유 계약.
 *
 * 확정 제품 결정:
 * - 비밀번호 암호문 저장·복호화·사이트 로그인 폼 감지·자동완성은 관리 Desktop 메인 프로세스가 소유한다.
 * - 설정 > '브라우저'에서 저장된 비밀번호를 보기·복사할 때 Touch ID 등 OS 인증을 거친다.
 * - 원격 콘솔·웹 브라우저 등 플릿 브라우저를 쓸 수 없는 환경에서는 설정 '브라우저' 항목을 숨기고 금고를 노출하지 않는다.
 * - 사용자 탭은 단일 계정이면 바로 채우고 복수 계정이면 입력칸 포커스 시 선택 목록을 띄우며,
 *   에이전트 탭(사령관·지휘관·구성원)은 폼이 보이면 최근 계정을 자동 채움하고 로그인 제출 시 저장 제안을 띄운다.
 * - 임시 세션(profile === null)에서도 저장된 계정으로 자동완성하고 로그인 제출 시 저장 제안을 띄운다.
 */

export const DESKTOP_BROWSER_PASSWORDS = "Fleet.browserPasswords";

export const BROWSER_PASSWORD_ORIGIN_MAX_LENGTH = 512;
export const BROWSER_PASSWORD_USERNAME_MAX_LENGTH = 512;
export const BROWSER_PASSWORD_SECRET_MAX_LENGTH = 4096;
export const BROWSER_PASSWORD_MAX_ENTRIES = 1000;
export const BROWSER_PASSWORD_MAX_NEVER_ORIGINS = 500;

export type BrowserPasswordVaultUnavailableReason =
  | "encryption_unavailable"
  | "desktop_required"
  | "vault_corrupted";

export type BrowserPasswordAuthErrorCode =
  | "os_auth_cancelled"
  | "os_auth_unavailable"
  | "os_auth_failed";

export type BrowserPasswordErrorCode =
  | BrowserPasswordVaultUnavailableReason
  | BrowserPasswordAuthErrorCode
  | "password_not_found"
  | "invalid_password_entry"
  | "vault_limit_reached";

/** Console 목록·UI 가 받는 메타데이터 요약. 평문 비밀번호는 절대 실리지 않는다. */
export interface BrowserPasswordSummary {
  readonly id: string;
  readonly origin: string;
  readonly username: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface BrowserPasswordVaultState {
  readonly available: boolean;
  readonly reason: BrowserPasswordVaultUnavailableReason | null;
  readonly offerToSave: boolean;
  readonly osAuthSupported: boolean;
  readonly entries: readonly BrowserPasswordSummary[];
  readonly neverSaveOrigins: readonly string[];
}

export type BrowserPasswordShellCommand =
  | { readonly action: "state" }
  | { readonly action: "reveal"; readonly id: string }
  | { readonly action: "copy"; readonly id: string }
  | { readonly action: "save"; readonly origin: string; readonly username: string; readonly password: string }
  | { readonly action: "update"; readonly id: string; readonly origin?: string; readonly username: string; readonly password?: string }
  | { readonly action: "delete"; readonly id: string }
  | { readonly action: "set-offer-to-save"; readonly enabled: boolean }
  | { readonly action: "add-never-save"; readonly origin: string }
  | { readonly action: "remove-never-save"; readonly origin: string };

export interface BrowserPasswordRevealResult {
  readonly password: string;
}

export interface BrowserPasswordCopyResult {
  readonly copied: true;
}

export interface BrowserPasswordSaveResult {
  readonly entry: BrowserPasswordSummary;
  readonly created: boolean;
}

export interface BrowserPasswordUpdateResult {
  readonly entry: BrowserPasswordSummary;
}

export interface BrowserPasswordDeleteResult {
  readonly deleted: boolean;
}

export interface BrowserPasswordOfferResult {
  readonly offerToSave: boolean;
}

export interface BrowserPasswordNeverSaveResult {
  readonly neverSaveOrigins: readonly string[];
}

const AUTH_ERROR_CODES = new Set<string>(["os_auth_cancelled", "os_auth_unavailable", "os_auth_failed"]);

export function isBrowserPasswordAuthErrorCode(value: unknown): value is BrowserPasswordAuthErrorCode {
  return typeof value === "string" && AUTH_ERROR_CODES.has(value);
}

/** `http:` / `https:` 출처만 정규화한다. 그 외 스킴(file·data·javascript 등)이나 불투명 출처는 거부한다. */
export function normalizeBrowserPasswordOrigin(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0 || trimmed.length > 4096) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const origin = parsed.origin;
  if (!origin || origin === "null" || origin.length > BROWSER_PASSWORD_ORIGIN_MAX_LENGTH) return null;
  return origin;
}
