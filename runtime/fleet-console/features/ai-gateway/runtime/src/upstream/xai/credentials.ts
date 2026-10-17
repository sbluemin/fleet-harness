import path from "node:path";

import {
  MAX_CREDENTIAL_BYTES,
  credentialRecord,
  optionalTrimmedString,
  type CredentialResolverDeps,
} from "../../transport/credentials.js";

const XAI_OIDC_ISSUER = "https://auth.x.ai";

export interface XaiCliCredentials {
  readonly accessToken: string;
  readonly expiresAt?: number;
  readonly userId?: string;
}

export type XaiCliAuthResult =
  | { readonly status: "ok"; readonly credentials: XaiCliCredentials }
  | { readonly status: "signed_out" }
  | { readonly status: "expired" };

/** The auth file written by the official Grok CLI. Fleet only reads it. */
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

/**
 * Read the first well-formed Grok CLI profile. A later profile is not a fallback:
 * an expired first profile would otherwise switch accounts. Never refreshes and
 * never writes the file — a refresh can rotate the CLI's own grant.
 */
export async function resolveXaiCliAuth(
  deps: CredentialResolverDeps,
  options: { readonly now?: () => number } = {},
): Promise<XaiCliAuthResult> {
  const now = options.now ?? Date.now;
  try {
    const raw = await deps.readBounded(xaiCliAuthFilePath(deps), MAX_CREDENTIAL_BYTES);
    if (raw === null || raw.length > MAX_CREDENTIAL_BYTES) return { status: "signed_out" };
    const auth = credentialRecord(JSON.parse(raw));
    if (!auth) return { status: "signed_out" };
    for (const [entryKey, value] of Object.entries(auth)) {
      if (!entryKey.startsWith(`${XAI_OIDC_ISSUER}::`)) continue;
      const entry = credentialRecord(value);
      const issuer = optionalTrimmedString(entry?.oidc_issuer);
      const accessToken = optionalTrimmedString(entry?.key);
      if (!entry || issuer !== XAI_OIDC_ISSUER || !accessToken) continue;
      const expiresAt = effectiveExpiry(entry, accessToken);
      if (expiresAt !== undefined && expiresAt <= now()) return { status: "expired" };
      const userId = optionalTrimmedString(entry.user_id) ?? optionalTrimmedString(entry.principal_id);
      return {
        status: "ok",
        credentials: {
          accessToken,
          ...(expiresAt === undefined ? {} : { expiresAt }),
          ...(userId === undefined ? {} : { userId }),
        },
      };
    }
    return { status: "signed_out" };
  } catch {
    return { status: "signed_out" };
  }
}
