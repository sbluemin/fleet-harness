import fs from "node:fs";
import path from "node:path";

import type { FolderEntry, FolderListResult } from "./types.js";

export type FolderBrowserErrorCode = "invalid_path" | "not_found" | "forbidden";

export class FolderBrowserError extends Error {
  readonly code: FolderBrowserErrorCode;

  constructor(code: FolderBrowserErrorCode) {
    super(code);
    this.name = "FolderBrowserError";
    this.code = code;
  }
}

const DIRECTORY_ENTRY_CAP = 500;

export async function listTheaterContents(
  theaterPath: string,
  relativePath: string,
  deps: { readonly opendir?: typeof fs.promises.opendir; readonly stat?: typeof fs.promises.stat } = {},
): Promise<FolderListResult> {
  const opendir = deps.opendir ?? fs.promises.opendir;
  const stat = deps.stat ?? fs.promises.stat;
  const targetAbs = path.resolve(theaterPath, relativePath);
  const normalizedRoot = theaterPath.endsWith(path.sep) ? theaterPath : theaterPath + path.sep;
  if (targetAbs !== theaterPath && !targetAbs.startsWith(normalizedRoot)) {
    throw new FolderBrowserError("forbidden");
  }

  // opendir/stat 전에 realpath로 심링크를 추적한 실제 경로를 얻어 containment 재검증한다.
  let realRoot: string;
  let realTargetAbs: string;
  try {
    [realRoot, realTargetAbs] = await Promise.all([
      fs.promises.realpath(theaterPath),
      fs.promises.realpath(targetAbs),
    ]);
  } catch (error) {
    throw mapFsError(error);
  }
  const realNormalizedRoot = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (realTargetAbs !== realRoot && !realTargetAbs.startsWith(realNormalizedRoot)) {
    throw new FolderBrowserError("forbidden");
  }

  const targetStat = await statDirectory(realTargetAbs, stat);
  if (!targetStat.isDirectory()) throw new FolderBrowserError("invalid_path");

  const entries: FolderEntry[] = [];
  const truncated = await collectContentsEntries(realTargetAbs, realRoot, opendir, stat, entries);
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const rel = path.relative(realRoot, realTargetAbs);
  const parentRel = rel === "" ? null : path.relative(realRoot, path.dirname(realTargetAbs));
  return {
    relativePath: rel,
    parentRelativePath: parentRel === "" ? null : (parentRel ?? null),
    entries,
    ...(truncated ? { truncated: true as const } : {}),
  };
}

async function statDirectory(targetPath: string, stat: typeof fs.promises.stat): Promise<fs.Stats> {
  try {
    return await stat(targetPath);
  } catch (error) {
    throw mapFsError(error);
  }
}

async function collectContentsEntries(
  targetPath: string,
  theaterPath: string,
  opendir: typeof fs.promises.opendir,
  stat: typeof fs.promises.stat,
  entries: FolderEntry[],
): Promise<boolean> {
  const directory = await openDirectory(targetPath, opendir);
  try {
    let dirent = await directory.read();
    while (dirent !== null) {
      if (entries.length >= DIRECTORY_ENTRY_CAP) return true;
      const entry = await toContentsEntry(targetPath, theaterPath, dirent, stat);
      if (entry !== null) entries.push(entry);
      dirent = await directory.read();
    }
    return false;
  } catch (error) {
    throw mapFsError(error);
  } finally {
    await directory.close();
  }
}

async function openDirectory(targetPath: string, opendir: typeof fs.promises.opendir): Promise<fs.Dir> {
  try {
    return await opendir(targetPath);
  } catch (error) {
    throw mapFsError(error);
  }
}

async function toContentsEntry(
  targetPath: string,
  theaterPath: string,
  dirent: fs.Dirent,
  stat: typeof fs.promises.stat,
): Promise<FolderEntry | null> {
  const entryPath = path.join(targetPath, dirent.name);
  const rel = path.relative(theaterPath, entryPath);
  if (dirent.isDirectory()) return { name: dirent.name, relativePath: rel, kind: "dir" };
  if (dirent.isFile()) return { name: dirent.name, relativePath: rel, kind: "file" };
  if (dirent.isSymbolicLink()) {
    try {
      // realpath로 심링크 대상의 실제 경로를 얻어 Theater 경계 이탈 여부를 확인한다.
      // (theaterPath는 listTheaterContents에서 이미 realpath 기준으로 전달된다.)
      const realEntryPath = await fs.promises.realpath(entryPath);
      const realNormalizedRoot = theaterPath.endsWith(path.sep) ? theaterPath : theaterPath + path.sep;
      if (realEntryPath !== theaterPath && !realEntryPath.startsWith(realNormalizedRoot)) return null;
      const s = await stat(realEntryPath);
      if (s.isDirectory()) return { name: dirent.name, relativePath: rel, kind: "dir" };
      if (s.isFile()) return { name: dirent.name, relativePath: rel, kind: "file" };
    } catch {
      return null;
    }
  }
  return null;
}

function mapFsError(error: unknown): FolderBrowserError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") return new FolderBrowserError("forbidden");
  if (code === "ENOENT" || code === "ENOTDIR") return new FolderBrowserError("not_found");
  return new FolderBrowserError("invalid_path");
}
