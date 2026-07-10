import type { RailPathContext } from "@fleet-console/sdk/rail";

export interface RailPathWorktree {
  readonly relPath: string;
  readonly branch: string | null;
  readonly isCurrent: boolean;
}

export interface RailPathWorktreesResult {
  readonly isGitRepo: boolean;
  readonly worktrees: readonly RailPathWorktree[];
}

export interface RailPathDirectory {
  readonly relPath: string;
  readonly label: string;
}

const FORBIDDEN_KEYS = new Set(["path", "cwd", "realpath", "token", "ticket", "gitdir", "folderGrantId"]);

export class PathContextApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function fetchRailPathContext(theaterId: string, signal?: AbortSignal): Promise<RailPathContext> {
  const response = await fetch(`/api/v1/theaters/${encodeURIComponent(theaterId)}/path-context`, { signal });
  await assertOk(response);
  return assertRailPathContext(await response.json(), response.status);
}

export async function putRailPathContext(theaterId: string, relPath: string | null, signal?: AbortSignal): Promise<RailPathContext> {
  if (relPath !== null) assertRelPath(relPath);
  const response = await fetch(`/api/v1/theaters/${encodeURIComponent(theaterId)}/path-context`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ relPath }),
    signal,
  });
  await assertOk(response);
  return assertRailPathContext(await response.json(), response.status);
}

export async function fetchRailPathWorktrees(theaterId: string, signal?: AbortSignal): Promise<RailPathWorktreesResult> {
  const response = await fetch(`/api/v1/theaters/${encodeURIComponent(theaterId)}/path-context/worktrees`, { signal });
  await assertOk(response);
  return assertRailPathWorktrees(await response.json(), response.status);
}

export async function fetchRailPathDirectories(theaterId: string, relativePath: string | null, signal?: AbortSignal): Promise<readonly RailPathDirectory[]> {
  if (relativePath !== null) assertRelPath(relativePath);
  const response = await fetch(`/api/v1/theaters/${encodeURIComponent(theaterId)}/path-context/directories`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ relativePath }),
    signal,
  });
  await assertOk(response);
  return assertRailPathDirectories(await response.json(), response.status);
}

export function assertRailPathContext(value: unknown, status = 200): RailPathContext {
  assertSafeObject(value, status);
  const payload = value as Record<string, unknown>;
  if ((payload.kind !== "root" && payload.kind !== "worktree" && payload.kind !== "directory") || !isValidLabel(payload.label)) {
    throw new PathContextApiError(status, "Invalid path context response");
  }
  if (payload.relPath !== null && (typeof payload.relPath !== "string" || !isSafeRelPath(payload.relPath))) {
    throw new PathContextApiError(status, "Invalid path context response");
  }
  if ((payload.kind === "root") !== (payload.relPath === null)) throw new PathContextApiError(status, "Invalid path context response");
  return { kind: payload.kind, relPath: payload.relPath, label: payload.label };
}

export function assertRailPathWorktrees(value: unknown, status = 200): RailPathWorktreesResult {
  assertSafeObject(value, status);
  const payload = value as Record<string, unknown>;
  if (typeof payload.isGitRepo !== "boolean" || !Array.isArray(payload.worktrees)) throw new PathContextApiError(status, "Invalid worktrees response");
  return {
    isGitRepo: payload.isGitRepo,
    worktrees: payload.worktrees.map((entry) => {
      assertSafeObject(entry, status);
      const worktree = entry as Record<string, unknown>;
      if (typeof worktree.relPath !== "string" || !isSafeRelPath(worktree.relPath) || (worktree.branch !== null && typeof worktree.branch !== "string") || typeof worktree.isCurrent !== "boolean") {
        throw new PathContextApiError(status, "Invalid worktrees response");
      }
      return { relPath: worktree.relPath, branch: worktree.branch, isCurrent: worktree.isCurrent };
    }),
  };
}

export function assertRailPathDirectories(value: unknown, status = 200): readonly RailPathDirectory[] {
  assertSafeObject(value, status);
  const payload = value as Record<string, unknown>;
  if (!Array.isArray(payload.directories)) throw new PathContextApiError(status, "Invalid directories response");
  return payload.directories.map((entry) => {
    assertSafeObject(entry, status);
    const directory = entry as Record<string, unknown>;
    if (typeof directory.relPath !== "string" || !isSafeRelPath(directory.relPath) || !isValidLabel(directory.label)) {
      throw new PathContextApiError(status, "Invalid directories response");
    }
    return { relPath: directory.relPath, label: directory.label };
  });
}

function assertRelPath(value: string): void {
  if (!isSafeRelPath(value)) throw new PathContextApiError(400, "Invalid relative path");
}

function isSafeRelPath(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && !value.includes("\0") && !value.includes("\\") && !value.startsWith("/") && !/^[A-Za-z]:/.test(value) && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

function isValidLabel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\0\r\n]/.test(value);
}

function assertSafeObject(value: unknown, status: number): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PathContextApiError(status, "Invalid path context response");
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) throw new PathContextApiError(status, "Unsafe path context response");
  }
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  let message = response.statusText || "Request failed";
  try {
    const payload = await response.json() as { error?: unknown };
    if (typeof payload.error === "string") message = payload.error;
  } catch { /* use status text */ }
  throw new PathContextApiError(response.status, message);
}
