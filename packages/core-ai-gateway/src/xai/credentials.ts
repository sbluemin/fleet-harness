import path from "node:path";

import {
  MAX_CREDENTIAL_BYTES,
  credentialRecord,
  optionalTrimmedString,
  type CredentialResolverDeps,
} from "../transport/credentials.js";

const XAI_OIDC_ISSUER = "https://auth.x.ai";

export interface XaiCliCredentials {
  readonly accessToken: string;
  readonly expiresAt?: number;
  readonly userId?: string;
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

/**
 * Read the credential the Grok CLI owns. Fleet never starts OAuth and never
 * rewrites this vendor-owned file; an expired session is repaired with `grok login`.
 */
export async function resolveXaiCliCredentials(
  deps: CredentialResolverDeps,
  now: () => number = Date.now,
): Promise<XaiCliCredentials | null> {
  try {
    const raw = await deps.readBounded(xaiCliAuthFilePath(deps), MAX_CREDENTIAL_BYTES);
    if (raw === null || raw.length > MAX_CREDENTIAL_BYTES) return null;
    const auth = credentialRecord(JSON.parse(raw));
    if (!auth) return null;

    for (const [entryKey, value] of Object.entries(auth)) {
      if (!entryKey.startsWith(`${XAI_OIDC_ISSUER}::`)) continue;
      const entry = credentialRecord(value);
      const issuer = optionalTrimmedString(entry?.oidc_issuer);
      const accessToken = optionalTrimmedString(entry?.key);
      if (issuer !== XAI_OIDC_ISSUER || !accessToken) continue;
      const expiresAt = expiry(entry?.expires_at);
      if (expiresAt !== undefined && expiresAt <= now()) continue;
      const userId = optionalTrimmedString(entry?.user_id)
        ?? optionalTrimmedString(entry?.principal_id);
      return {
        accessToken,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(userId === undefined ? {} : { userId }),
      };
    }
    return null;
  } catch {
    return null;
  }
}
