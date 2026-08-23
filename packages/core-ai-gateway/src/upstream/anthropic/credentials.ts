import path from "node:path";

import { MAX_CREDENTIAL_BYTES, credentialRecord, type CredentialResolverDeps } from "../../transport/credentials.js";
import type { CredentialMethod } from "../../quota/types.js";

export interface ClaudeCredentials {
  readonly accessToken: string;
  readonly expiresAt?: number;
  readonly subscriptionType?: string;
  /** Login-snapshot extra-usage multiplier, e.g. `default_claude_max_20x`. */
  readonly rateLimitTier?: string;
  readonly method: CredentialMethod;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalEpoch(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseClaudeCredentialJson(raw: string, method: CredentialMethod): ClaudeCredentials | null {
  if (raw.length > MAX_CREDENTIAL_BYTES) return null;
  try {
    const parsed = credentialRecord(JSON.parse(raw));
    if (!parsed) return null;
    const oauth = credentialRecord(parsed.claudeAiOauth);
    const accessToken = optionalString(oauth?.accessToken ?? parsed.accessToken);
    if (!accessToken) return null;
    const rateLimitTier = optionalString(oauth?.rateLimitTier ?? parsed.rateLimitTier);
    return {
      accessToken,
      expiresAt: optionalEpoch(oauth?.expiresAt ?? parsed.expiresAt),
      subscriptionType: optionalString(oauth?.subscriptionType ?? parsed.subscriptionType),
      ...(rateLimitTier === undefined ? {} : { rateLimitTier }),
      method,
    };
  } catch {
    return null;
  }
}

export async function resolveClaudeCredentials(deps: CredentialResolverDeps): Promise<ClaudeCredentials | null> {
  if (deps.platform === "darwin") {
    try {
      const raw = await deps.execFile(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { timeout: 5_000 },
      );
      const credential = raw.length <= MAX_CREDENTIAL_BYTES
        ? parseClaudeCredentialJson(raw, "keychain")
        : null;
      if (credential) return credential;
    } catch {
      // The credentials file is the required macOS fallback.
    }
  }
  const configDir = deps.env.CLAUDE_CONFIG_DIR || path.join(deps.homedir(), ".claude");
  try {
    const raw = await deps.readBounded(path.join(configDir, ".credentials.json"), MAX_CREDENTIAL_BYTES);
    return raw === null || raw.length > MAX_CREDENTIAL_BYTES ? null : parseClaudeCredentialJson(raw, "file");
  } catch {
    return null;
  }
}
