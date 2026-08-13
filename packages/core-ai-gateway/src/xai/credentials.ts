import fs from "node:fs/promises";
import path from "node:path";

import {
  MAX_CREDENTIAL_BYTES,
  credentialRecord,
  optionalTrimmedString,
  type CredentialResolverDeps,
} from "../transport/credentials.js";

export const XAI_OIDC_ISSUER = "https://auth.x.ai";
export const XAI_CLI_REFRESH_URL = "https://auth.x.ai/oauth2/token";
export const XAI_CLI_DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
/** Same 5-minute early-refresh window the Grok CLI and OpenUsage use. */
export const XAI_CLI_REFRESH_BUFFER_MS = 5 * 60 * 1_000;
const REFRESH_TIMEOUT_MS = 15_000;
const FALLBACK_ACCESS_TOKEN_TTL_MS = 3_600_000;

export interface XaiCliCredentials {
  readonly accessToken: string;
  readonly expiresAt?: number;
  readonly userId?: string;
}

export type XaiCliAuthResult =
  | { readonly status: "ok"; readonly credentials: XaiCliCredentials }
  | { readonly status: "signed_out" }
  | { readonly status: "expired" };

export interface ResolveXaiCliOptions {
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
  readonly writeAuthFile?: (filePath: string, contents: string) => Promise<void>;
  /** After a 401/403, refresh even if the local clock still thinks the token is good. */
  readonly forceRefresh?: boolean;
}

/** The auth file written and refreshed by the official Grok CLI. */
export function xaiCliAuthFilePath(deps: CredentialResolverDeps): string {
  return path.join(deps.env.GROK_HOME || path.join(deps.homedir(), ".grok"), "auth.json");
}

function expiry(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed < 1e12 ? Math.round(parsed * 1_000) : Math.round(parsed);
}

function jwtExpiry(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as unknown;
    const record = credentialRecord(payload);
    const exp = record?.exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;
    return Math.round(exp * 1_000);
  } catch {
    return undefined;
  }
}

function effectiveExpiry(entry: Record<string, unknown>, accessToken: string): number | undefined {
  const fromEntry = expiry(entry.expires_at) ?? expiry(entry.expires);
  const fromJwt = jwtExpiry(accessToken);
  if (fromEntry !== undefined && fromJwt !== undefined) return Math.min(fromEntry, fromJwt);
  return fromEntry ?? fromJwt;
}

function clientId(entryKey: string, entry: Record<string, unknown>): string {
  const fromEntry = optionalTrimmedString(entry.oidc_client_id);
  if (fromEntry) return fromEntry;
  const suffix = optionalTrimmedString(entryKey.split("::").at(-1));
  return suffix ?? XAI_CLI_DEFAULT_CLIENT_ID;
}

function refreshToken(entry: Record<string, unknown>): string | undefined {
  return optionalTrimmedString(entry.refresh_token) ?? optionalTrimmedString(entry.refresh);
}

async function defaultWriteAuthFile(filePath: string, contents: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmpPath, contents, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

async function persistRefreshedEntry(
  deps: CredentialResolverDeps,
  filePath: string,
  entryKey: string,
  expected: { readonly accessToken: string; readonly refreshToken?: string },
  patch: Record<string, string>,
  writeAuthFile: (filePath: string, contents: string) => Promise<void>,
): Promise<void> {
  // Re-read so a concurrent `grok login` / CLI refresh is not replaced by a
  // reconstructed object that would drop the other profiles' fields. Skip the
  // write when this entry's tokens already moved: Fleet's response may be from
  // the refresh grant we started with, and overwriting a rotated pair revokes
  // the file owner's newer session.
  const raw = await deps.readBounded(filePath, MAX_CREDENTIAL_BYTES);
  if (raw === null) return;
  const auth = credentialRecord(JSON.parse(raw));
  if (!auth) return;
  const current = credentialRecord(auth[entryKey]);
  if (!current) return;
  if (optionalTrimmedString(current.key) !== expected.accessToken) return;
  if (expected.refreshToken !== undefined && refreshToken(current) !== expected.refreshToken) return;
  auth[entryKey] = { ...current, ...patch };
  await writeAuthFile(filePath, `${JSON.stringify(auth, null, 2)}\n`);
}

async function refreshAccessToken(
  entryKey: string,
  entry: Record<string, unknown>,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<{ readonly accessToken: string; readonly expiresAt: number; readonly refreshToken?: string } | null> {
  const token = refreshToken(entry);
  if (!token) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId(entryKey, entry),
      refresh_token: token,
    });
    const response = await fetchImpl(XAI_CLI_REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = credentialRecord(await response.json());
    const accessToken = optionalTrimmedString(payload?.access_token);
    if (!accessToken) return null;
    const expiresIn = payload?.expires_in;
    const expiresAt = typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
      ? now() + Math.round(expiresIn * 1_000)
      : jwtExpiry(accessToken) ?? now() + FALLBACK_ACCESS_TOKEN_TTL_MS;
    const rotated = optionalTrimmedString(payload?.refresh_token);
    return {
      accessToken,
      expiresAt,
      ...(rotated === undefined ? {} : { refreshToken: rotated }),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the credential the Grok CLI owns. Fleet never starts OAuth; it may persist
 * a silent refresh into this same vendor file (the CLI and OpenUsage do too) so a
 * still-renewable session is not reported as signed out.
 */
export async function resolveXaiCliAuth(
  deps: CredentialResolverDeps,
  options: ResolveXaiCliOptions = {},
): Promise<XaiCliAuthResult> {
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetch ?? fetch;
  const writeAuthFile = options.writeAuthFile ?? defaultWriteAuthFile;
  const filePath = xaiCliAuthFilePath(deps);
  try {
    const raw = await deps.readBounded(filePath, MAX_CREDENTIAL_BYTES);
    if (raw === null || raw.length > MAX_CREDENTIAL_BYTES) return { status: "signed_out" };
    const auth = credentialRecord(JSON.parse(raw));
    if (!auth) return { status: "signed_out" };

    let sawExpired = false;
    for (const [entryKey, value] of Object.entries(auth)) {
      if (!entryKey.startsWith(`${XAI_OIDC_ISSUER}::`)) continue;
      const entry = credentialRecord(value);
      const issuer = optionalTrimmedString(entry?.oidc_issuer);
      const accessToken = optionalTrimmedString(entry?.key);
      if (!entry || issuer !== XAI_OIDC_ISSUER || !accessToken) continue;
      const expiresAt = effectiveExpiry(entry, accessToken);
      const expired = expiresAt !== undefined && expiresAt <= now();
      const needsRefresh = options.forceRefresh === true
        || (expiresAt !== undefined && expiresAt - now() <= XAI_CLI_REFRESH_BUFFER_MS);

      if (needsRefresh) {
        const refreshed = await refreshAccessToken(entryKey, entry, fetchImpl, now);
        if (refreshed) {
          const userId = optionalTrimmedString(entry.user_id)
            ?? optionalTrimmedString(entry.principal_id);
          const patch: Record<string, string> = {
            key: refreshed.accessToken,
            expires_at: new Date(refreshed.expiresAt).toISOString(),
          };
          if (refreshed.refreshToken !== undefined) patch.refresh_token = refreshed.refreshToken;
          try {
            await persistRefreshedEntry(
              deps,
              filePath,
              entryKey,
              { accessToken, refreshToken: refreshToken(entry) },
              patch,
              writeAuthFile,
            );
          } catch {
            // In-memory token is still usable this probe; the next read retries persist.
          }
          return {
            status: "ok",
            credentials: {
              accessToken: refreshed.accessToken,
              expiresAt: refreshed.expiresAt,
              ...(userId === undefined ? {} : { userId }),
            },
          };
        }
        if (options.forceRefresh === true || expired) {
          sawExpired = true;
          continue;
        }
      } else if (expired) {
        sawExpired = true;
        continue;
      }

      const userId = optionalTrimmedString(entry.user_id)
        ?? optionalTrimmedString(entry.principal_id);
      return {
        status: "ok",
        credentials: {
          accessToken,
          ...(expiresAt === undefined ? {} : { expiresAt }),
          ...(userId === undefined ? {} : { userId }),
        },
      };
    }
    return { status: sawExpired ? "expired" : "signed_out" };
  } catch {
    return { status: "signed_out" };
  }
}

export async function resolveXaiCliCredentials(
  deps: CredentialResolverDeps,
  nowOrOptions: (() => number) | ResolveXaiCliOptions = Date.now,
): Promise<XaiCliCredentials | null> {
  const options: ResolveXaiCliOptions = typeof nowOrOptions === "function"
    ? { now: nowOrOptions }
    : nowOrOptions;
  const result = await resolveXaiCliAuth(deps, options);
  return result.status === "ok" ? result.credentials : null;
}
