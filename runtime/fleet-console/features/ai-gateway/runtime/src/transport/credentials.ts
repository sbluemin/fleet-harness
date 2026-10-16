/**
 * Mechanics for reading a credential another CLI left on this machine.
 *
 * Only providers whose sign-in Fleet does not own still read vendor stores here:
 * Claude Code (quota only) and the Antigravity CLI (`agy`). Codex, xAI, Cursor,
 * and Muse Code sign in through Console and live solely in the Console slot's
 * `auth.json` (`src/oauth/`); they never read vendor files, the environment, or
 * the OS keychain.
 *
 * This file holds only provider-unaware mechanics: bounded file I/O, platform
 * resolver deps, and the shared credential shapes. Each provider's login path,
 * auth-file parsing, and keychain handling lives in its own provider folder
 * (`src/upstream/anthropic/credentials.ts`, `src/upstream/antigravity/credentials.ts`).
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

// Provider credential *result* types live in each provider folder next to the
// resolver that returns them; transport stays provider-unaware.

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
    // Console runs detached without a console; a hidden child keeps Windows from opening a window per lookup.
    const result = await execFileAsync(file, [...args], { ...options, windowsHide: true });
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
