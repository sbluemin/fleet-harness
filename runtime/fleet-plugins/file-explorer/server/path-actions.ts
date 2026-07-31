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

export interface ResolvedActionPath {
  readonly logicalPath: string;
  readonly realPath: string;
}

export async function resolveContainedActionPath(
  theaterPath: string,
  relativePath: string,
): Promise<ResolvedActionPath> {
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

  return {
    // Preserve the row the user acted on for display-only actions such as copying path text.
    logicalPath: candidatePath,
    // Process-launch actions must use the same resolved path that passed containment.
    realPath: realCandidatePath,
  };
}

function isPathContained(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
