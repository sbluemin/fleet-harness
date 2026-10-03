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
  if (!isPathContained(root, candidate)) throw new FileResolveError("outside_theater");
  try {
    const [realRoot, realCandidate] = await Promise.all([fs.realpath(root), fs.realpath(candidate)]);
    if (!isPathContained(realRoot, realCandidate)) throw new FileResolveError("outside_theater");
    const stat = await fs.stat(realCandidate);
    if (!stat.isFile() && !stat.isDirectory()) throw new FileResolveError("not_found");
    return { path: path.relative(realRoot, realCandidate).split(path.sep).join("/"), kind: stat.isDirectory() ? "dir" : "file" };
  } catch (error) {
    if (error instanceof FileResolveError) throw error;
    throw new FileResolveError("not_found");
  }
}
