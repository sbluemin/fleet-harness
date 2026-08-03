import path from "node:path";

import {
  MAX_CREDENTIAL_BYTES,
  credentialRecord,
  defaultCredentialDeps,
  readBoundedFile,
  resolveCodexCredentials,
  resolveCursorCredentials,
} from "@dotobokuri/core-ai-gateway";
import type {
  CodexCredentials,
  CredentialResolverDeps,
  CursorCredentials,
} from "@dotobokuri/core-ai-gateway";

import type { CredentialMethod } from "./types.js";

// Cursor/Codex 자격증명 조달은 core-ai-gateway가 단일 출처다. Console AI gateway 라우트도 같은
// 구현을 쓰므로, 여기서 다시 구현하면 조달 규칙이 한쪽에만 반영되는 과거 불일치가 되살아난다.
export {
  MAX_CREDENTIAL_BYTES,
  defaultCredentialDeps,
  readBoundedFile,
  resolveCodexCredentials,
  resolveCursorCredentials,
};
export type { CodexCredentials, CredentialResolverDeps, CursorCredentials };

export interface ClaudeCredentials {
  readonly accessToken: string;
  readonly expiresAt?: number;
  readonly subscriptionType?: string;
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
    return {
      accessToken,
      expiresAt: optionalEpoch(oauth?.expiresAt ?? parsed.expiresAt),
      subscriptionType: optionalString(oauth?.subscriptionType ?? parsed.subscriptionType),
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
