import fs from "node:fs";
import path from "node:path";

export interface TheaterPathContextResolution {
  readonly realRoot: string;
  readonly realPath: string;
  readonly relPath: string | null;
  readonly label: string;
}

export interface TheaterDirectoryEntry {
  readonly relPath: string;
  readonly label: string;
}

export class TheaterPathContextError extends Error {
  readonly code: "invalid_path" | "not_found" | "forbidden";

  constructor(code: TheaterPathContextError["code"]) {
    super(code);
    this.code = code;
  }
}

const DIRECTORY_ENTRY_CAP = 500;

export async function resolveTheaterPathContext(theaterRoot: string, relPath: string | null): Promise<TheaterPathContextResolution> {
  if (relPath !== null && !isSafeRelativePath(relPath)) throw new TheaterPathContextError("invalid_path");
  const nominalRoot = path.resolve(theaterRoot);
  const nominalTarget = relPath === null ? nominalRoot : path.resolve(nominalRoot, ...relPath.split("/"));
  if (!isWithinRoot(nominalTarget, nominalRoot)) throw new TheaterPathContextError("forbidden");
  let realRoot: string;
  let realPath: string;
  try {
    [realRoot, realPath] = await Promise.all([fs.promises.realpath(nominalRoot), fs.promises.realpath(nominalTarget)]);
  } catch (error) {
    throw mapFsError(error);
  }
  if (!isWithinRoot(realPath, realRoot)) throw new TheaterPathContextError("forbidden");
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(realPath);
  } catch (error) {
    throw mapFsError(error);
  }
  if (!stat.isDirectory()) throw new TheaterPathContextError("invalid_path");
  const canonicalRel = path.relative(realRoot, realPath).split(path.sep).join("/");
  return { realRoot, realPath, relPath: canonicalRel === "" ? null : canonicalRel, label: path.basename(realPath) || path.basename(realRoot) || "Theater" };
}

export async function listTheaterDirectories(theaterRoot: string, parentRelPath: string | null): Promise<readonly TheaterDirectoryEntry[]> {
  const parent = await resolveTheaterPathContext(theaterRoot, parentRelPath);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(parent.realPath, { withFileTypes: true });
  } catch (error) {
    throw mapFsError(error);
  }
  const result: TheaterDirectoryEntry[] = [];
  for (const entry of entries) {
    if (result.length >= DIRECTORY_ENTRY_CAP) break;
    const candidate = path.join(parent.realPath, entry.name);
    try {
      const realCandidate = await fs.promises.realpath(candidate);
      if (!isWithinRoot(realCandidate, parent.realRoot)) continue;
      const stat = await fs.promises.stat(realCandidate);
      if (!stat.isDirectory()) continue;
      const relPath = path.relative(parent.realRoot, realCandidate).split(path.sep).join("/");
      if (relPath) result.push({ relPath, label: path.basename(realCandidate) });
    } catch { /* omit inaccessible, broken, and escaping entries */ }
  }
  return result.sort((left, right) => left.label.localeCompare(right.label));
}

export function isSafeRelativePath(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && !value.includes("\0") && !value.includes("\\") && !value.startsWith("/") && !/^[A-Za-z]:/.test(value) && !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function isWithinRoot(candidate: string, root: string): boolean {
  const normalizedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return candidate === root || candidate.startsWith(normalizedRoot);
}

function mapFsError(error: unknown): TheaterPathContextError {
  return (error as NodeJS.ErrnoException).code === "ENOENT" ? new TheaterPathContextError("not_found") : new TheaterPathContextError("invalid_path");
}
