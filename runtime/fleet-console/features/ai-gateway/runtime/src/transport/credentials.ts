/**
 * Provider credential procurement for the subscription tokens the gateway spends.
 *
 * Where a provider CLI leaves its login is provider knowledge, not Fleet
 * knowledge, so every consumer that needs a token — the Console AI gateway route
 * and the quota plugin — resolves it through this package. Keeping a second
 * copy is what let the gateway stay macOS-only for Cursor while quota already
 * worked everywhere, and what left the gateway blind to `CODEX_HOME`.
 *
 * This file holds only provider-unaware mechanics: bounded file I/O, platform
 * resolver deps, and the shared credential shapes. Each provider's login path,
 * auth-file parsing, and keychain handling lives in its own provider folder
 * (`src/upstream/cursor/credentials.ts`, `src/upstream/codex/credentials.ts`).
 */

import { execFile as nodeExecFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

export type CredentialMethod = "keychain" | "file";

export interface CredentialResolverDeps {
  readonly platform: NodeJS.Platform;
  readonly homedir: () => string;
  readonly env: NodeJS.ProcessEnv;
  readonly readBounded: (filePath: string, maxBytes: number) => Promise<string | null>;
  readonly execFile: (file: string, args: readonly string[], options: { readonly timeout: number }) => Promise<string>;
}

// Provider credential *result* types (CursorCredentials, CodexCredentials) live in each
// provider folder next to the resolver that returns them; transport stays provider-unaware.

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
