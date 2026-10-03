import fs from "node:fs/promises";
import path from "node:path";

import { isPathContained } from "./path-actions.js";

export class FileResolveError extends Error {
  constructor(readonly code: "outside_theater" | "not_found") {
    super(code);
  }
}

export interface FileResolveResult {
  readonly path: string;
  readonly kind: "file" | "dir";
}

export async function resolveFileForTheater(
  theaterPath: string,
  requestedPath: string,
  pathKind: "theater-relative" | "absolute",
): Promise<FileResolveResult> {
  const root = path.resolve(theaterPath);
  if ((pathKind === "absolute") !== path.isAbsolute(requestedPath)) throw new FileResolveError("outside_theater");
  const candidate = path.resolve(root, requestedPath);
  if (pathKind === "theater-relative" && !isPathContained(root, candidate)) throw new FileResolveError("outside_theater");
  try {
    const [realRoot, target] = await Promise.all([fs.realpath(root), resolveExistingAncestor(candidate)]);
    if (!isPathContained(realRoot, target.path)) throw new FileResolveError("outside_theater");
    if (target.missing) throw new FileResolveError("not_found");
    const realCandidate = target.path;
    const stat = await fs.stat(realCandidate);
    if (!stat.isFile() && !stat.isDirectory()) throw new FileResolveError("not_found");
    return { path: path.relative(realRoot, realCandidate).split(path.sep).join("/"), kind: stat.isDirectory() ? "dir" : "file" };
  } catch (error) {
    if (error instanceof FileResolveError) throw error;
    throw new FileResolveError("not_found");
  }
}

/** 없는 잎도 존재하는 조상까지 실제 경로로 풀어 별칭과 심링크 경계를 판정한다. */
async function resolveExistingAncestor(candidate: string): Promise<{ readonly path: string; readonly missing: boolean }> {
  let ancestor = candidate;
  const suffix: string[] = [];
  for (;;) {
    try {
      return { path: path.join(await fs.realpath(ancestor), ...suffix), missing: suffix.length > 0 };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}
