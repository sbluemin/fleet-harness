import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface FolderGrantStoreDeps {
  readonly randomId?: () => string;
  readonly statSync?: typeof fs.statSync;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export interface FolderGrantStore {
  issue(cwd: string): string;
  consume(folderGrantId: string): string | null;
}

interface StoredGrant {
  readonly cwd: string;
  readonly expiresAt: number;
}

const GRANT_ID_BYTES = 24;
// folderGrant는 폴더 선택 직후의 짧은 세션 생성 흐름에서만 쓰인다. 유출된 grant가 오래
// 살아남지 못하도록 terminal ticket과 같은 단명 TTL을 적용하고, issue/consume마다 prune한다.
const DEFAULT_GRANT_TTL_MS = 60_000;

export function createFolderGrantStore(deps: FolderGrantStoreDeps = {}): FolderGrantStore {
  const randomId = deps.randomId ?? (() => crypto.randomBytes(GRANT_ID_BYTES).toString("base64url"));
  const statSync = deps.statSync ?? fs.statSync;
  const ttlMs = deps.ttlMs ?? DEFAULT_GRANT_TTL_MS;
  const now = deps.now ?? Date.now;
  const grants = new Map<string, StoredGrant>();

  function issue(cwd: string): string {
    prune();
    const normalized = validateAbsoluteDirectory(cwd, statSync);
    const folderGrantId = randomId();
    grants.set(folderGrantId, { cwd: normalized, expiresAt: now() + ttlMs });
    return folderGrantId;
  }

  function consume(folderGrantId: string): string | null {
    prune();
    const stored = grants.get(folderGrantId);
    grants.delete(folderGrantId);
    if (!stored || stored.expiresAt <= now()) return null;
    return stored.cwd;
  }

  function prune(): void {
    const current = now();
    for (const [id, stored] of grants) {
      if (stored.expiresAt <= current) grants.delete(id);
    }
  }

  return { issue, consume };
}

export function validateAbsoluteDirectory(cwd: string, statSync: typeof fs.statSync = fs.statSync): string {
  if (!path.isAbsolute(cwd)) throw new Error("invalid_folder");
  const normalized = path.resolve(cwd);
  if (!statSync(normalized).isDirectory()) throw new Error("invalid_folder");
  return normalized;
}
