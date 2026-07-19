import fs from "node:fs/promises";
import path from "node:path";

// ─── types ───────────────────────────────────────────────────────────────────

export type ProjectPathErrorCode = "invalid_path" | "not_found" | "path_outside_theater";

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

export async function resolveProjectCwd(theaterRoot: string): Promise<string> {
  const lexicalRoot = path.resolve(theaterRoot);
  let realRoot: string;
  try {
    realRoot = await fs.realpath(lexicalRoot);
  } catch (error) {
    throw mapFilesystemError(error);
  }

  try {
    if (!(await fs.stat(realRoot)).isDirectory()) {
      throw new ProjectPathError("invalid_path");
    }
  } catch (error) {
    if (error instanceof ProjectPathError) throw error;
    throw mapFilesystemError(error);
  }

  return realRoot;
}

function mapFilesystemError(error: unknown): ProjectPathError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") return new ProjectPathError("path_outside_theater");
  if (code === "ENOENT" || code === "ENOTDIR") return new ProjectPathError("not_found");
  return new ProjectPathError("invalid_path");
}
