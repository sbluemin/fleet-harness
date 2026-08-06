import path from "node:path";

import {
  MAX_CREDENTIAL_BYTES,
  credentialRecord,
  type CredentialResolverDeps,
} from "../transport/credentials.js";

export interface CodexCredentials {
  readonly accessToken: string;
  /**
   * Absent when the login left no account id. Callers that must send the
   * `chatgpt-account-id` header treat that as no usable credential; the quota
   * reader does not need it.
   */
  readonly accountId?: string;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The auth file Codex CLI's ChatGPT login writes. `CODEX_HOME` relocates the
 * whole Codex home, so ignoring it reads the wrong path for anyone who set it.
 */
export function codexAuthFilePath(deps: CredentialResolverDeps): string {
  return path.join(deps.env.CODEX_HOME || path.join(deps.homedir(), ".codex"), "auth.json");
}

export async function resolveCodexCredentials(deps: CredentialResolverDeps): Promise<CodexCredentials | null> {
  try {
    const raw = await deps.readBounded(codexAuthFilePath(deps), MAX_CREDENTIAL_BYTES);
    if (raw === null || raw.length > MAX_CREDENTIAL_BYTES) return null;
    const parsed = credentialRecord(JSON.parse(raw));
    const tokens = credentialRecord(parsed?.tokens);
    // Both former copies stored the token verbatim; trimming here would silently
    // change the credential the gateway sends upstream.
    const accessToken = optionalNonEmptyString(tokens?.access_token);
    if (!accessToken) return null;
    const accountId = optionalNonEmptyString(tokens?.account_id);
    return accountId === undefined ? { accessToken } : { accessToken, accountId };
  } catch {
    return null;
  }
}
