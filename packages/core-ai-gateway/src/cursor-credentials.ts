/**
 * Provider credential procurement for the Cursor subscription token.
 *
 * Where Cursor leaves its login is provider knowledge, not Fleet knowledge, so
 * every consumer that needs the token — the Console AI gateway route and the
 * quota plugin — resolves it through this one module. Keeping a second copy is
 * what let the gateway stay macOS-only while quota already worked everywhere.
 */

import { execFile as nodeExecFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export type CredentialMethod = "keychain" | "file";

export interface CredentialResolverDeps {
  readonly platform: NodeJS.Platform;
  readonly homedir: () => string;
  readonly env: NodeJS.ProcessEnv;
  readonly readBounded: (filePath: string, maxBytes: number) => Promise<string | null>;
  readonly execFile: (file: string, args: readonly string[], options: { readonly timeout: number }) => Promise<string>;
}

export interface CursorCredentials {
  readonly accessToken: string;
  readonly method: CredentialMethod;
}

const execFileAsync = promisify(nodeExecFile);

export const MAX_CREDENTIAL_BYTES = 65_536;

// FIFO를 "r"로 열면 writer가 붙을 때까지 open 자체가 블록되어 뒤의 isFile 거부에 도달하지 못한다.
// POSIX에서는 O_NONBLOCK으로 열어 즉시 디스크립터를 받은 뒤 거부한다. Windows에는 이 플래그도
// 경로 네임스페이스상의 FIFO도 없으므로 기본 읽기 플래그를 그대로 쓴다.
const CREDENTIAL_OPEN_FLAGS = process.platform === "win32"
  ? fsConstants.O_RDONLY
  : fsConstants.O_RDONLY | fsConstants.O_NONBLOCK;

export async function readBoundedFile(filePath: string, maxBytes: number): Promise<string | null> {
  const handle = await fs.open(filePath, CREDENTIAL_OPEN_FLAGS);
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

export function credentialRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function optionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseCursorCredentialJson(raw: string, method: CredentialMethod): CursorCredentials | null {
  if (raw.length > MAX_CREDENTIAL_BYTES) return null;
  try {
    const parsed = credentialRecord(JSON.parse(raw));
    if (!parsed) return null;
    const tokens = credentialRecord(parsed.tokens);
    const cursorAuth = credentialRecord(parsed.cursorAuth);
    const accessToken = [
      parsed.accessToken,
      parsed.access_token,
      tokens?.accessToken,
      tokens?.access_token,
      cursorAuth?.accessToken,
      cursorAuth?.access_token,
    ].map(optionalTrimmedString).find((value) => value !== undefined);
    return accessToken ? { accessToken, method } : null;
  } catch {
    return null;
  }
}

/**
 * The auth file Cursor's CLI/IDE login writes, per platform. macOS keeps the
 * token in the keychain and uses this only as a fallback; on Linux and Windows
 * it is the sole source, so skipping it is what produced a 401 there.
 */
export function cursorAuthFilePath(deps: CredentialResolverDeps): string {
  const home = deps.homedir();
  if (deps.platform === "win32") {
    return path.join(deps.env.APPDATA || path.join(home, "AppData", "Roaming"), "Cursor", "auth.json");
  }
  if (deps.platform === "darwin") {
    return path.join(home, ".cursor", "auth.json");
  }
  return path.join(deps.env.XDG_CONFIG_HOME || path.join(home, ".config"), "cursor", "auth.json");
}

export async function resolveCursorCredentials(deps: CredentialResolverDeps): Promise<CursorCredentials | null> {
  if (deps.platform === "darwin") {
    try {
      const raw = await deps.execFile(
        "security",
        ["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"],
        { timeout: 5_000 },
      );
      const accessToken = raw.length <= MAX_CREDENTIAL_BYTES ? optionalTrimmedString(raw) : undefined;
      if (accessToken) return { accessToken, method: "keychain" };
    } catch {
      // The auth file is the required macOS fallback.
    }
  }
  try {
    const raw = await deps.readBounded(cursorAuthFilePath(deps), MAX_CREDENTIAL_BYTES);
    return raw === null || raw.length > MAX_CREDENTIAL_BYTES
      ? null
      : parseCursorCredentialJson(raw, "file");
  } catch {
    return null;
  }
}
