import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function workspaceHash(canonicalCwd: string): string {
  return crypto.createHash("sha256").update(canonicalCwd).digest("hex").slice(0, 12);
}

export async function canonicalizeTheaterPath(cwd: string): Promise<string> {
  return canonicalizeTheaterPathSync(cwd);
}

export function canonicalizeTheaterPathSync(cwd: string): string {
  const resolved = path.resolve(cwd);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function theaterLabel(cwd: string): string {
  return path.basename(cwd) || cwd;
}
