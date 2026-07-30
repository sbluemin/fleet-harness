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
  readonly readBounded: (filePath: string, maxBytes: number) => Promise<string | null>;
  readonly execFile: (file: string, args: readonly string[], options: { readonly timeout: number }) => Promise<string>;
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

async function readBoundedFile(filePath: string, maxBytes: number): Promise<string | null> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    // Bound during I/O: a stalled network mount or non-regular path (for example, FIFO) must not wedge single-flight.
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let totalBytes = 0;
    while (totalBytes < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        totalBytes,
        buffer.byteLength - totalBytes,
        totalBytes,
      );
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
    }
    return totalBytes > maxBytes ? null : buffer.subarray(0, totalBytes).toString("utf8");
  } finally {
    await handle.close();
  }
}

export const defaultCredentialDeps: CredentialResolverDeps = {
  platform: process.platform,
  homedir: os.homedir,
  env: process.env,
  readBounded: readBoundedFile,
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

export async function resolveCodexCredentials(deps: CredentialResolverDeps): Promise<CodexCredentials | null> {
  const home = deps.env.CODEX_HOME || path.join(deps.homedir(), ".codex");
  try {
    const raw = await deps.readBounded(path.join(home, "auth.json"), MAX_CREDENTIAL_BYTES);
    if (raw === null || raw.length > MAX_CREDENTIAL_BYTES) return null;
    const parsed = record(JSON.parse(raw));
    const tokens = record(parsed?.tokens);
    const accessToken = optionalString(tokens?.access_token);
    if (!accessToken) return null;
    return { accessToken, accountId: optionalString(tokens?.account_id) };
  } catch {
    return null;
  }
}
