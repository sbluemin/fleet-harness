import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

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
} from "@fleet-console/protocol/desktop/browser-passwords";

/**
 * 창을 든 Desktop 메인 프로세스가 소유하는 비밀번호 금고. 모든 스페이스와
 * 임시 세션(profile === null)이 이 단일 금고를 함께 쓴다 — 프로필별 분기가 없다.
 *
 * 디스크에는 safeStorage 암호문(base64)과 메타데이터만 남고 평문은 절대 쓰지 않는다.
 * 암호화를 쓸 수 없거나 파일이 손상되면 fail-closed 로 거부하고 평문 폴백은 없다.
 */

const VAULT_FILE_NAME = "browser-password-vault.json";
const VAULT_FILE_VERSION = 1;
/** 항목 수 상한(1000개)이 있어 파일 크기는 자연히 묶이지만, 읽기 전 한 번 더 둑을 둔다. */
const VAULT_FILE_MAX_BYTES = 8 * 1_024 * 1_024;
const OS_AUTH_REASON = "Fleet에 저장된 비밀번호 보기";

export class BrowserPasswordVaultError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "BrowserPasswordVaultError";
    this.code = code;
  }
}

/** Electron safeStorage 의 주입 포트. 실제 앱에서는 Electron 값을 그대로 연결한다. */
export interface BrowserPasswordSafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** Electron systemPreferences 의 주입 포트(OS 인증 게이트). */
export interface BrowserPasswordSystemPreferences {
  canPromptTouchID(): boolean;
  promptTouchID(reason: string): Promise<void>;
}

/** Electron clipboard 의 주입 포트. copy 는 인증 직후 메인에서 직접 쓴다. */
export interface BrowserPasswordClipboard {
  writeText(text: string): void;
}

/**
 * 메인 내부 전용 조회 결과 — 자동완성·저장 판정이 쓴다. 평문이 들었으므로
 * `command` 로는 절대 내보내지 않고 격리 월드 채움에만 쓴다.
 */
export interface BrowserPasswordPageCredential {
  readonly id: string;
  readonly username: string;
  readonly password: string;
  readonly updatedAt: number;
}

export interface BrowserPasswordOriginCredentials {
  readonly offerToSave: boolean;
  readonly neverSaved: boolean;
  readonly credentials: readonly BrowserPasswordPageCredential[];
}

export interface BrowserPasswordOsAuth {
  canPrompt(): boolean;
  prompt(reason: string): Promise<void>;
}

export interface BrowserPasswordVaultDeps {
  /** Desktop 소유 데이터 루트(실제 앱에서는 app.getPath("userData")). */
  readonly root: string;
  readonly safeStorage: BrowserPasswordSafeStorage;
  readonly systemPreferences: BrowserPasswordSystemPreferences;
  readonly clipboard: BrowserPasswordClipboard;
  readonly osAuth?: BrowserPasswordOsAuth;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
  readonly randomId?: () => string;
}

interface StoredPasswordEntry {
  readonly id: string;
  readonly origin: string;
  readonly username: string;
  readonly ciphertext: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface StoredVaultFile {
  readonly offerToSave: boolean;
  readonly neverSaveOrigins: string[];
  readonly entries: StoredPasswordEntry[];
}

const err = (code: BrowserPasswordErrorCode | "desktop_shell_unsupported"): BrowserPasswordVaultError =>
  new BrowserPasswordVaultError(code);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

function validatedUsername(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > BROWSER_PASSWORD_USERNAME_MAX_LENGTH) throw err("invalid_password_entry");
  return raw;
}

function validatedPassword(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > BROWSER_PASSWORD_SECRET_MAX_LENGTH) throw err("invalid_password_entry");
  return raw;
}

function validatedOrigin(raw: unknown): string {
  if (typeof raw !== "string") throw err("invalid_password_entry");
  const normalized = normalizeBrowserPasswordOrigin(raw);
  if (normalized === null || normalized.length > BROWSER_PASSWORD_ORIGIN_MAX_LENGTH) throw err("invalid_password_entry");
  return normalized;
}

function validatedId(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) throw err("password_not_found");
  return raw;
}

function isStoredEntry(value: unknown): value is StoredPasswordEntry {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && value.id.length > 0
    && typeof value.origin === "string" && typeof value.username === "string"
    && typeof value.ciphertext === "string" && value.ciphertext.length > 0
    && typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
    && typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt);
}

function parseVaultFile(text: string): StoredVaultFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw err("vault_corrupted");
  }
  if (!isRecord(parsed)) throw err("vault_corrupted");
  const file = parsed;
  if (file.version !== undefined && file.version !== VAULT_FILE_VERSION) throw err("vault_corrupted");
  if (file.offerToSave !== undefined && typeof file.offerToSave !== "boolean") throw err("vault_corrupted");
  if (file.neverSaveOrigins !== undefined && (!Array.isArray(file.neverSaveOrigins) || !file.neverSaveOrigins.every((origin): origin is string => typeof origin === "string"))) throw err("vault_corrupted");
  if (!Array.isArray(file.entries) || !file.entries.every(isStoredEntry)) throw err("vault_corrupted");
  return {
    offerToSave: typeof file.offerToSave === "boolean" ? file.offerToSave : true,
    neverSaveOrigins: Array.isArray(file.neverSaveOrigins) ? [...file.neverSaveOrigins as string[]] : [],
    entries: [...file.entries as StoredPasswordEntry[]],
  };
}

export function createBrowserPasswordVault(deps: BrowserPasswordVaultDeps) {
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  const randomId = deps.randomId ?? randomUUID;
  const file = path.join(deps.root, VAULT_FILE_NAME);

  const ensureEncryption = (): void => {
    let available = false;
    try {
      available = deps.safeStorage.isEncryptionAvailable();
    } catch {
      available = false;
    }
    if (!available) throw err("encryption_unavailable");
  };

  const touchIdSupported = (): boolean => {
    if (platform !== "darwin") return false;
    try {
      return deps.systemPreferences.canPromptTouchID();
    } catch {
      return false;
    }
  };

  const fallbackOsAuthSupported = (): boolean => {
    if (platform !== "darwin" && platform !== "win32") return false;
    try {
      return deps.osAuth?.canPrompt() === true;
    } catch {
      return false;
    }
  };

  const osAuthSupported = (): boolean => touchIdSupported() || fallbackOsAuthSupported();

  /**
   * reveal·copy 전용 OS 인증 게이트(크롬 OS별 정책 준수).
   * - macOS: Touch ID 지원 시 promptTouchID, 미지원(Mac mini 등) 시 Mac 암호 창(osAuth)
   * - Windows: Windows Hello / OS 인증(osAuth)
   * - Linux: 크롬과 같이 추가 OS 암호 창 없이 금고 복호화 허용
   * 존재 여부와 무관하게 먼저 묻는다(열람 없는 판별 금지).
   */
  const requireOsAuth = async (): Promise<void> => {
    if (platform === "linux") return;
    const useTouchId = touchIdSupported();
    const useFallback = !useTouchId && fallbackOsAuthSupported();
    if (!useTouchId && !useFallback) throw err("os_auth_unavailable");
    try {
      if (useTouchId) await deps.systemPreferences.promptTouchID(OS_AUTH_REASON);
      else await deps.osAuth!.prompt(OS_AUTH_REASON);
    } catch (error) {
      if (error instanceof BrowserPasswordVaultError) throw error;
      const errObj = error as { message?: unknown; stderr?: unknown; code?: unknown };
      const message = `${errObj?.message instanceof Error ? errObj.message.message : String(errObj?.message ?? error)} ${typeof errObj?.stderr === "string" ? errObj.stderr : ""}`;
      if (/cancel|-128/i.test(message)) throw err("os_auth_cancelled");
      if (/unavailable|not_present/i.test(message)) throw err("os_auth_unavailable");
      throw err("os_auth_failed");
    }
  };

  const load = (): StoredVaultFile | null => {
    try {
      if (fs.lstatSync(file).isSymbolicLink()) throw err("vault_corrupted");
    } catch (error) {
      if (error instanceof BrowserPasswordVaultError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw err("vault_corrupted");
      return null;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err("vault_corrupted");
    }
    if (!stat.isFile() || stat.size > VAULT_FILE_MAX_BYTES) throw err("vault_corrupted");
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      throw err("vault_corrupted");
    }
    return parseVaultFile(text);
  };

  const store = (vault: StoredVaultFile): void => {
    fs.mkdirSync(deps.root, { recursive: true, mode: 0o700 });
    try {
      if (fs.lstatSync(file).isSymbolicLink()) throw err("vault_corrupted");
    } catch (error) {
      if (error instanceof BrowserPasswordVaultError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const payload = JSON.stringify({
      version: VAULT_FILE_VERSION,
      offerToSave: vault.offerToSave,
      neverSaveOrigins: vault.neverSaveOrigins,
      entries: vault.entries.map((entry) => ({
        id: entry.id,
        origin: entry.origin,
        username: entry.username,
        ciphertext: entry.ciphertext,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      })),
    });
    const temporary = `${file}.${randomId()}.tmp`;
    try {
      fs.writeFileSync(temporary, payload, { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  };

  const encrypt = (password: string): string => {
    try {
      return deps.safeStorage.encryptString(password).toString("base64");
    } catch {
      throw err("encryption_unavailable");
    }
  };

  const decrypt = (ciphertext: string): string => {
    let raw: Buffer;
    try {
      raw = Buffer.from(ciphertext, "base64");
    } catch {
      throw err("vault_corrupted");
    }
    try {
      return deps.safeStorage.decryptString(raw);
    } catch {
      throw err("vault_corrupted");
    }
  };

  const summarize = (entry: StoredPasswordEntry): BrowserPasswordSummary => ({
    id: entry.id,
    origin: entry.origin,
    username: entry.username,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  });

  const blankState = (reason: BrowserPasswordVaultState["reason"], vault: StoredVaultFile | null): BrowserPasswordVaultState => ({
    available: false,
    reason,
    offerToSave: vault?.offerToSave ?? true,
    osAuthSupported: osAuthSupported(),
    entries: [],
    neverSaveOrigins: vault ? [...vault.neverSaveOrigins] : [],
  });

  const state = (): BrowserPasswordVaultState => {
    let vault: StoredVaultFile;
    try {
      vault = load() ?? { offerToSave: true, neverSaveOrigins: [], entries: [] };
    } catch {
      return blankState("vault_corrupted", null);
    }
    // 저장된 항목이 없을 때는 macOS 키체인(safeStorage.isEncryptionAvailable)을 건드리지 않는다 —
    // 설정 화면만 열거나 빈 금고로 웹을 탐색할 때 키체인 허용 창이 뜨지 않게 실제로 쓸 때까지 미룬다.
    if (vault.entries.length > 0) {
      let encryption = false;
      try {
        encryption = deps.safeStorage.isEncryptionAvailable();
      } catch {
        encryption = false;
      }
      if (!encryption) return blankState("encryption_unavailable", vault);
    }
    return {
      available: true,
      reason: null,
      offerToSave: vault.offerToSave,
      osAuthSupported: osAuthSupported(),
      entries: vault.entries.map(summarize),
      neverSaveOrigins: [...vault.neverSaveOrigins],
    };
  };

  const reveal = async (params: Record<string, unknown>): Promise<{ password: string }> => {
    ensureEncryption();
    const id = validatedId(readString(params, "id"));
    const vault = load() ?? { offerToSave: true, neverSaveOrigins: [], entries: [] };
    await requireOsAuth();
    const entry = vault.entries.find((candidate) => candidate.id === id);
    if (!entry) throw err("password_not_found");
    return { password: decrypt(entry.ciphertext) };
  };

  const copy = async (params: Record<string, unknown>): Promise<{ copied: true }> => {
    ensureEncryption();
    const id = validatedId(readString(params, "id"));
    const vault = load() ?? { offerToSave: true, neverSaveOrigins: [], entries: [] };
    await requireOsAuth();
    const entry = vault.entries.find((candidate) => candidate.id === id);
    if (!entry) throw err("password_not_found");
    deps.clipboard.writeText(decrypt(entry.ciphertext));
    return { copied: true };
  };

  const save = (params: Record<string, unknown>): { entry: BrowserPasswordSummary; created: boolean } => {
    ensureEncryption();
    const origin = validatedOrigin(readString(params, "origin"));
    const username = validatedUsername(params.username);
    const password = validatedPassword(params.password);
    const vault = load() ?? { offerToSave: true, neverSaveOrigins: [], entries: [] };
    const timestamp = now();
    // 크롬과 같이 저장하면 그 사이트의 저장 안 함을 함께 푼다 — 다시 물을 필요 없이 그 계정을 쓴다는 뜻이다.
    const keepNever = vault.neverSaveOrigins.filter((candidate) => candidate !== origin);
    const existing = vault.entries.find((candidate) => candidate.origin === origin && candidate.username === username);
    if (existing) {
      const next: StoredPasswordEntry = { ...existing, ciphertext: encrypt(password), updatedAt: timestamp };
      store({ ...vault, neverSaveOrigins: keepNever, entries: vault.entries.map((candidate) => (candidate.id === existing.id ? next : candidate)) });
      return { entry: summarize(next), created: false };
    }
    if (vault.entries.length >= BROWSER_PASSWORD_MAX_ENTRIES) throw err("vault_limit_reached");
    const next: StoredPasswordEntry = { id: randomId(), origin, username, ciphertext: encrypt(password), createdAt: timestamp, updatedAt: timestamp };
    store({ ...vault, neverSaveOrigins: keepNever, entries: [...vault.entries, next] });
    return { entry: summarize(next), created: true };
  };

  const update = (params: Record<string, unknown>): { entry: BrowserPasswordSummary } => {
    ensureEncryption();
    const id = validatedId(readString(params, "id"));
    const rawOrigin = readString(params, "origin");
    const origin = rawOrigin === undefined ? undefined : validatedOrigin(rawOrigin);
    const username = validatedUsername(params.username);
    const rawPassword = params.password;
    const password = rawPassword === undefined ? undefined : validatedPassword(rawPassword);
    const vault = load() ?? { offerToSave: true, neverSaveOrigins: [], entries: [] };
    const existing = vault.entries.find((candidate) => candidate.id === id);
    if (!existing) throw err("password_not_found");
    const nextOrigin = origin ?? existing.origin;
    const clash = vault.entries.find((candidate) => candidate.id !== id && candidate.origin === nextOrigin && candidate.username === username);
    if (clash) throw err("invalid_password_entry");
    const next: StoredPasswordEntry = {
      ...existing,
      origin: nextOrigin,
      username,
      ciphertext: password === undefined ? existing.ciphertext : encrypt(password),
      updatedAt: now(),
    };
    store({ ...vault, entries: vault.entries.map((candidate) => (candidate.id === id ? next : candidate)) });
    return { entry: summarize(next) };
  };

  const remove = (params: Record<string, unknown>): { deleted: boolean } => {
    ensureEncryption();
    const id = validatedId(readString(params, "id"));
    const vault = load() ?? { offerToSave: true, neverSaveOrigins: [], entries: [] };
    if (!vault.entries.some((candidate) => candidate.id === id)) return { deleted: false };
    store({ ...vault, entries: vault.entries.filter((candidate) => candidate.id !== id) });
    return { deleted: true };
  };

  const setOfferToSave = (params: Record<string, unknown>): { offerToSave: boolean } => {
    ensureEncryption();
    const enabled = params.enabled;
    if (typeof enabled !== "boolean") throw err("invalid_password_entry");
    const vault = load() ?? { offerToSave: true, neverSaveOrigins: [], entries: [] };
    store({ ...vault, offerToSave: enabled });
    return { offerToSave: enabled };
  };

  const addNeverSave = (params: Record<string, unknown>): { neverSaveOrigins: string[] } => {
    ensureEncryption();
    const origin = validatedOrigin(readString(params, "origin"));
    const vault = load() ?? { offerToSave: true, neverSaveOrigins: [], entries: [] };
    if (vault.neverSaveOrigins.includes(origin)) return { neverSaveOrigins: [...vault.neverSaveOrigins] };
    if (vault.neverSaveOrigins.length >= BROWSER_PASSWORD_MAX_NEVER_ORIGINS) throw err("vault_limit_reached");
    const next = [...vault.neverSaveOrigins, origin];
    store({ ...vault, neverSaveOrigins: next });
    return { neverSaveOrigins: next };
  };

  const removeNeverSave = (params: Record<string, unknown>): { neverSaveOrigins: string[] } => {
    ensureEncryption();
    const origin = validatedOrigin(readString(params, "origin"));
    const vault = load() ?? { offerToSave: true, neverSaveOrigins: [], entries: [] };
    const next = vault.neverSaveOrigins.filter((candidate) => candidate !== origin);
    if (next.length !== vault.neverSaveOrigins.length) store({ ...vault, neverSaveOrigins: next });
    return { neverSaveOrigins: next };
  };

  /**
   * 메인 내부 전용 조회 — 자동완성·저장 판정이 쓴다. OS 인증을 묻지 않으므로
   * 셸 명령·REST·렌더러로는 절대 내보내지 않는다. 평문이 돌아간다.
   */
  const forOrigin = (origin: string): BrowserPasswordOriginCredentials => {
    const normalized = normalizeBrowserPasswordOrigin(origin);
    if (normalized === null) throw err("invalid_password_entry");
    const vault = load() ?? { offerToSave: true, neverSaveOrigins: [], entries: [] };
    const matched = vault.entries.filter((entry) => entry.origin === normalized);
    if (matched.length > 0) ensureEncryption();
    return {
      offerToSave: vault.offerToSave,
      neverSaved: vault.neverSaveOrigins.includes(normalized),
      credentials: matched
        .map((entry) => ({ id: entry.id, username: entry.username, password: decrypt(entry.ciphertext), updatedAt: entry.updatedAt })),
    };
  };

  const command = async (params: Record<string, unknown>): Promise<unknown> => {
    const action = readString(params, "action");
    switch (action as BrowserPasswordShellCommand["action"]) {
      case "state": return state();
      case "reveal": return reveal(params);
      case "copy": return copy(params);
      case "save": return save(params);
      case "update": return update(params);
      case "delete": return remove(params);
      case "set-offer-to-save": return setOfferToSave(params);
      case "add-never-save": return addNeverSave(params);
      case "remove-never-save": return removeNeverSave(params);
      default: throw err("desktop_shell_unsupported");
    }
  };

  return { command, state, forOrigin };
}

export type BrowserPasswordVault = ReturnType<typeof createBrowserPasswordVault>;
