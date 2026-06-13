import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface FolderGrantStoreDeps {
  readonly randomId?: () => string;
  readonly statSync?: typeof fs.statSync;
}

export interface FolderGrantStore {
  issue(cwd: string): string;
  consume(folderGrantId: string): string | null;
}

const GRANT_ID_BYTES = 24;

export function createFolderGrantStore(deps: FolderGrantStoreDeps = {}): FolderGrantStore {
  const randomId = deps.randomId ?? (() => crypto.randomBytes(GRANT_ID_BYTES).toString("base64url"));
  const statSync = deps.statSync ?? fs.statSync;
  const grants = new Map<string, string>();

  function issue(cwd: string): string {
    const normalized = validateAbsoluteDirectory(cwd, statSync);
    const folderGrantId = randomId();
    grants.set(folderGrantId, normalized);
    return folderGrantId;
  }

  function consume(folderGrantId: string): string | null {
    const cwd = grants.get(folderGrantId) ?? null;
    grants.delete(folderGrantId);
    return cwd;
  }

  return { issue, consume };
}

export function validateAbsoluteDirectory(cwd: string, statSync: typeof fs.statSync = fs.statSync): string {
  if (!path.isAbsolute(cwd)) throw new Error("invalid_folder");
  const normalized = path.resolve(cwd);
  if (!statSync(normalized).isDirectory()) throw new Error("invalid_folder");
  return normalized;
}
