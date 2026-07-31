import fs from "node:fs/promises";
import path from "node:path";

export type PathActionErrorCode = "path_outside_theater" | "not_found" | "forbidden";

export class PathActionError extends Error {
  readonly code: PathActionErrorCode;

  constructor(code: PathActionErrorCode) {
    super(code);
    this.name = "PathActionError";
    this.code = code;
  }
}

export async function resolveContainedActionPath(theaterPath: string, relativePath: string): Promise<string> {
  if (path.isAbsolute(relativePath)) throw new PathActionError("path_outside_theater");
  const rootPath = path.resolve(theaterPath);
  const candidatePath = path.resolve(rootPath, relativePath);
  if (!isPathContained(rootPath, candidatePath)) throw new PathActionError("path_outside_theater");

  let realRootPath: string;
  let realCandidatePath: string;
  try {
    [realRootPath, realCandidatePath] = await Promise.all([
      fs.realpath(rootPath),
      fs.realpath(candidatePath),
    ]);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") throw new PathActionError("forbidden");
    throw new PathActionError("not_found");
  }

  if (!isPathContained(realRootPath, realCandidatePath)) {
    throw new PathActionError("path_outside_theater");
  }

  // The logical Theater path preserves the row the user acted on (including a safe in-Theater symlink),
  // while the real path above is used only to prove that the target cannot escape the Theater.
  return candidatePath;
}

function isPathContained(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
