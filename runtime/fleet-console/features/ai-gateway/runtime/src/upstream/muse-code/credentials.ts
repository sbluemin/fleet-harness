import path from "node:path";

import {
  MAX_CREDENTIAL_BYTES,
  credentialRecord,
  type CredentialMethod,
  type CredentialResolverDeps,
} from "../../transport/credentials.js";

/**
 * Muse Code CLI(`muse login`)가 남긴 로그인. 읽기 전용이며 OAuth·키 발급·갱신·기록은 하지 않는다.
 *
 * - 메타데이터: `$XDG_CONFIG_HOME/muse/auth.json`(기본 `~/.config/muse/auth.json`).
 *   `schema_version` 2, `providers.meta.{mechanism: "oauth", storage}`. 비밀값은 없다.
 * - `storage: "keychain"`: macOS generic password `ai.meta.dev.credentials`/`meta`의 JSON
 *   `{secret_schema_version: 1, api_key, access_token}`. refresh 토큰·만료 시각은 없다(실측).
 * - `storage: "file" | "keychain_fallback_file"`: 같은 키 이름이 `providers.meta`에 있다(CLI 문자열 근거, 미실측).
 *
 * `MUSE_AUTH_PATH`·`META_API_KEY`는 읽지 않는다. 앞은 사용자가 로그인하지 않은 파일로,
 * 뒤는 과금 체계가 다른 종량제 키로 경로를 바꾸기 때문이다.
 */
export interface MuseCredentials {
  /** Model API 키. Gateway 추론이 보내는 유일한 자격 증명이다. */
  readonly apiKey?: string;
  /** Meta 계정 토큰. 사용량 조회만 쓰고 추론은 쓰지 않는다. */
  readonly accountToken?: string;
  /** epoch ms. 저장된 비밀값이 밝힐 때만 있다. */
  readonly expiresAt?: number;
  readonly method: CredentialMethod;
}

export type MuseAuthUnavailableReason = "keychain_denied" | "keychain_timeout" | "malformed";

export type MuseAuthResult =
  | { readonly status: "ok"; readonly credentials: MuseCredentials }
  | { readonly status: "signed_out" }
  | { readonly status: "unavailable"; readonly reason: MuseAuthUnavailableReason };

/** `providers` 아래 키이자 키체인 계정 이름. */
const MUSE_PROVIDER_KEY = "meta";
export const MUSE_KEYCHAIN_SERVICE = "ai.meta.dev.credentials";
const MUSE_KEYCHAIN_ACCOUNT = MUSE_PROVIDER_KEY;
const SECURITY_BINARY = "/usr/bin/security";
/** 항목이 없으면 `security`는 44(errSecItemNotFound)로 끝난다. */
const SECURITY_ITEM_NOT_FOUND = 44;
const KEYCHAIN_TIMEOUT_MS = 5_000;

/**
 * 이해하는 레이아웃만 받는다(fail closed). 새 레이아웃은 비밀값 위치를 바꿀 수 있어,
 * 추측하면 잘못된 자격 증명을 업스트림에 보낼 수 있다. CLI도 모르는 버전은 거부한다.
 */
const SUPPORTED_AUTH_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([2]);
const SUPPORTED_SECRET_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([1]);

const SIGNED_OUT: MuseAuthResult = Object.freeze({ status: "signed_out" as const });

function unavailable(reason: MuseAuthUnavailableReason): MuseAuthResult {
  return { status: "unavailable", reason };
}

export function museAuthFilePath(deps: CredentialResolverDeps): string {
  const configHome = deps.env.XDG_CONFIG_HOME || path.join(deps.homedir(), ".config");
  return path.join(configHome, "muse", "auth.json");
}

/**
 * 로그인 상태를 판정한다. 실패는 예외나 문구가 아닌 상태로만 돌려준다 — 비밀값, 도구 출력 원문,
 * 계정 정보(메타데이터에 이름·이메일이 있다)가 로그나 응답으로 새지 않게 하기 위해서다.
 */
export async function resolveMuseAuth(deps: CredentialResolverDeps): Promise<MuseAuthResult> {
  let raw: string | null;
  try {
    raw = await deps.readBounded(museAuthFilePath(deps), MAX_CREDENTIAL_BYTES);
  } catch (error) {
    // 파일이 없을 때만 미로그인이다. 읽을 수 없는 파일은 다른 답이다.
    return isMissingFile(error) ? SIGNED_OUT : unavailable("malformed");
  }
  if (raw === null || raw.length > MAX_CREDENTIAL_BYTES) return unavailable("malformed");

  let metadata: Record<string, unknown> | null;
  try {
    metadata = credentialRecord(JSON.parse(raw));
  } catch {
    return unavailable("malformed");
  }
  if (!metadata) return unavailable("malformed");
  const schemaVersion = metadata.schema_version;
  if (typeof schemaVersion !== "number" || !SUPPORTED_AUTH_SCHEMA_VERSIONS.has(schemaVersion)) {
    return unavailable("malformed");
  }
  const provider = credentialRecord(credentialRecord(metadata.providers)?.[MUSE_PROVIDER_KEY]);
  if (!provider) return SIGNED_OUT;
  // 구독 로그인이 아니면 이 공급자의 자격 증명이 아니다.
  if (provider.mechanism !== "oauth") return SIGNED_OUT;

  switch (provider.storage) {
    case "keychain":
      return readKeychainSecret(deps);
    case "file":
    case "keychain_fallback_file":
      return parseSecret(provider, "file", false);
    default:
      return unavailable("malformed");
  }
}

async function readKeychainSecret(deps: CredentialResolverDeps): Promise<MuseAuthResult> {
  // 다른 플랫폼의 비밀 저장소는 미구현이다. "미로그인"이라 하면 이미 한 로그인을 다시 시키게 된다.
  if (deps.platform !== "darwin") return unavailable("keychain_denied");
  let output: string;
  try {
    output = await deps.execFile(
      SECURITY_BINARY,
      ["find-generic-password", "-s", MUSE_KEYCHAIN_SERVICE, "-a", MUSE_KEYCHAIN_ACCOUNT, "-w"],
      { timeout: KEYCHAIN_TIMEOUT_MS },
    );
  } catch (error) {
    // 종료 상태만 본다. 메시지·stderr는 읽지도 노출하지도 않는다.
    return keychainFailure(error);
  }
  if (typeof output !== "string" || output.length > MAX_CREDENTIAL_BYTES * 2 + 1) {
    return unavailable("malformed");
  }
  const text = keychainText(output.trim());
  if (text === undefined) return unavailable("malformed");
  let payload: Record<string, unknown> | null;
  try {
    payload = credentialRecord(JSON.parse(text));
  } catch {
    return unavailable("malformed");
  }
  return payload ? parseSecret(payload, "keychain", true) : unavailable("malformed");
}

/** `security -w`는 출력 불가 바이트가 있으면 값 전체를 hex로 낸다. 실측은 평문 JSON이었다. */
function keychainText(output: string): string | undefined {
  if (output.startsWith("{")) return output;
  if (output.length === 0 || output.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(output)) return undefined;
  const decoded = Buffer.from(output, "hex").toString("utf8");
  return decoded.startsWith("{") && decoded.length <= MAX_CREDENTIAL_BYTES ? decoded : undefined;
}

function keychainFailure(error: unknown): MuseAuthResult {
  const failure = credentialRecord(error);
  if (failure?.code === SECURITY_ITEM_NOT_FOUND) return SIGNED_OUT;
  if (failure?.killed === true || failure?.code === "ETIMEDOUT" || typeof failure?.signal === "string") {
    return unavailable("keychain_timeout");
  }
  // 승인 거부, 잠긴 키체인, 이 프로세스를 제외한 ACL이 모두 여기로 온다.
  return unavailable("keychain_denied");
}

/**
 * 비밀값 필드를 검증하고 원문 그대로 둔다. 키체인 payload는 버전이 필수다. 파일 저장은
 * 미실측이라 버전이 있을 때만 검사한다.
 */
function parseSecret(
  secret: Record<string, unknown>,
  method: CredentialMethod,
  requireSchemaVersion: boolean,
): MuseAuthResult {
  const version = secret.secret_schema_version;
  if (version !== undefined || requireSchemaVersion) {
    if (typeof version !== "number" || !SUPPORTED_SECRET_SCHEMA_VERSIONS.has(version)) {
      return unavailable("malformed");
    }
  }
  const apiKey = optionalSecretString(secret.api_key);
  const accountToken = optionalSecretString(secret.access_token);
  if (apiKey === null || accountToken === null) return unavailable("malformed");
  if (apiKey === undefined && accountToken === undefined) return unavailable("malformed");
  const expiresAt = epochMs(secret.expires_at);
  if (expiresAt === null) return unavailable("malformed");
  return {
    status: "ok",
    credentials: {
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(accountToken === undefined ? {} : { accountToken }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      method,
    },
  };
}

/** 없으면 `undefined`, 모양이 틀리면 `null`. trim하지 않는다. */
function optionalSecretString(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  return value.trim().length > 0 ? value : undefined;
}

/** epoch 초·ms 또는 ISO 시각. 잘못된 값은 `null`. */
function epochMs(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed < 1e12 ? Math.round(parsed * 1_000) : Math.round(parsed);
}

function isMissingFile(error: unknown): boolean {
  const code = credentialRecord(error)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** 추론이 쓸 키, 또는 키가 없을 때 사용자가 따라 할 안내. 문구에는 비밀·원문·계정 정보를 싣지 않는다. */
export type MuseInferenceKey =
  | { readonly apiKey: string }
  | { readonly apiKey?: undefined; readonly message: string };

/**
 * 추론은 Model API 키만 쓴다. 계정 토큰만 있거나 로컬 만료 표기가 지났다는 이유로 키를
 * 거부하지 않는다 — 키의 유효성은 업스트림이 판정한다.
 */
export function museInferenceKey(result: MuseAuthResult | undefined): MuseInferenceKey {
  if (result?.status === "ok") {
    return result.credentials.apiKey !== undefined
      ? { apiKey: result.credentials.apiKey }
      : { message: "The Muse Code sign-in holds no Model API key. Run `muse login` again." };
  }
  if (result?.status === "unavailable") {
    switch (result.reason) {
      case "keychain_denied":
        return { message: "Fleet could not read the Muse Code sign-in from the macOS keychain. Allow access to it, or run `muse login` again." };
      case "keychain_timeout":
        return { message: "Reading the Muse Code sign-in from the macOS keychain timed out. Unlock the keychain and retry." };
      case "malformed":
        return { message: "The Muse Code sign-in could not be read. Run `muse login` again." };
    }
  }
  return { message: "No active Muse Code sign-in was found. Run `muse login` first." };
}
