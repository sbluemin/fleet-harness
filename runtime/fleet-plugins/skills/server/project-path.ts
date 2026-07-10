import fs from "node:fs/promises";
import path from "node:path";

// ─── types ───────────────────────────────────────────────────────────────────

export type ProjectPathErrorCode = "invalid_rel_path" | "not_found" | "path_outside_theater";

// ─── classes ─────────────────────────────────────────────────────────────────

export class ProjectPathError extends Error {
  readonly code: ProjectPathErrorCode;

  constructor(code: ProjectPathErrorCode) {
    super(code);
    this.name = "ProjectPathError";
    this.code = code;
  }
}

// ─── functions ───────────────────────────────────────────────────────────────

export async function resolveProjectCwd(theaterRoot: string, relPath: string | null): Promise<string> {
  if (relPath !== null && !isSafeRelativePath(relPath)) {
    throw new ProjectPathError("invalid_rel_path");
  }

  const lexicalRoot = path.resolve(theaterRoot);
  const lexicalTarget = path.resolve(lexicalRoot, relPath ?? ".");
  if (!isContainedBy(lexicalRoot, lexicalTarget)) {
    throw new ProjectPathError("path_outside_theater");
  }

  let realRoot: string;
  let realTarget: string;
  try {
    [realRoot, realTarget] = await Promise.all([
      fs.realpath(lexicalRoot),
      fs.realpath(lexicalTarget),
    ]);
  } catch (error) {
    throw mapFilesystemError(error);
  }
  if (!isContainedBy(realRoot, realTarget)) {
    throw new ProjectPathError("path_outside_theater");
  }

  try {
    if (!(await fs.stat(realTarget)).isDirectory()) {
      throw new ProjectPathError("invalid_rel_path");
    }
  } catch (error) {
    if (error instanceof ProjectPathError) throw error;
    throw mapFilesystemError(error);
  }

  return realTarget;
}

export function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes("\0") || path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return false;
  }
  return value.split(/[\\/]/).every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isContainedBy(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

function mapFilesystemError(error: unknown): ProjectPathError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") return new ProjectPathError("path_outside_theater");
  if (code === "ENOENT" || code === "ENOTDIR") return new ProjectPathError("not_found");
  return new ProjectPathError("invalid_rel_path");
}
