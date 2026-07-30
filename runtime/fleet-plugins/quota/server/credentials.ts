import { execFile as nodeExecFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { CredentialMethod } from "./types.js";

export interface CredentialResolverDeps {
  readonly platform: NodeJS.Platform;
  readonly homedir: () => string;
  readonly env: NodeJS.ProcessEnv;
  readonly readFile: (filePath: string, encoding: BufferEncoding) => Promise<string>;
  readonly execFile: (file: string, args: readonly string[], options: { readonly timeout: number }) => Promise<string>;
  readonly stat?: (filePath: string) => Promise<{ readonly size: number }>;
}

export interface ClaudeCredentials {
  readonly accessToken: string;
  readonly expiresAt?: number;
  readonly subscriptionType?: string;
  readonly method: CredentialMethod;
}

export interface CodexCredentials {
  readonly accessToken: string;
  readonly accountId?: string;
}

const execFileAsync = promisify(nodeExecFile);
const MAX_CREDENTIAL_BYTES = 65_536;

export const defaultCredentialDeps: CredentialResolverDeps = {
  platform: process.platform,
  homedir: os.homedir,
  env: process.env,
  readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
  stat: (filePath) => fs.stat(filePath),
  execFile: async (file, args, options) => {
    const result = await execFileAsync(file, [...args], options);
    return result.stdout;
  },
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
    const parsed = record(JSON.parse(raw));
    if (!parsed) return null;
    const oauth = record(parsed.claudeAiOauth);
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

async function readCredentialFile(
  filePath: string,
  deps: CredentialResolverDeps,
): Promise<string | null> {
  if (deps.stat && (await deps.stat(filePath)).size > MAX_CREDENTIAL_BYTES) return null;
  const raw = await deps.readFile(filePath, "utf8");
  return raw.length <= MAX_CREDENTIAL_BYTES ? raw : null;
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
    const raw = await readCredentialFile(path.join(configDir, ".credentials.json"), deps);
    return raw === null ? null : parseClaudeCredentialJson(raw, "file");
  } catch {
    return null;
  }
}

export async function resolveCodexCredentials(deps: CredentialResolverDeps): Promise<CodexCredentials | null> {
  const home = deps.env.CODEX_HOME || path.join(deps.homedir(), ".codex");
  try {
    const raw = await readCredentialFile(path.join(home, "auth.json"), deps);
    if (raw === null) return null;
    const parsed = record(JSON.parse(raw));
    const tokens = record(parsed?.tokens);
    const accessToken = optionalString(tokens?.access_token);
    if (!accessToken) return null;
    return { accessToken, accountId: optionalString(tokens?.account_id) };
  } catch {
    return null;
  }
}
