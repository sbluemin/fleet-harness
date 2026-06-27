import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ConsoleTheaterFolderListEntry, ConsoleTheaterFolderListResponse } from "./api-types.js";

export interface TheaterContentsEntry {
  readonly name: string;
  readonly relativePath: string;
  readonly kind: "dir" | "file";
}

export interface TheaterContentsListResult {
  readonly relativePath: string;
  readonly parentRelativePath: string | null;
  readonly entries: readonly TheaterContentsEntry[];
  readonly truncated?: true;
}

export type TheaterFolderListErrorCode = "invalid_path" | "not_found" | "forbidden";

export interface TheaterFolderBrowserDeps {
  readonly platform?: NodeJS.Platform;
  readonly cwd?: () => string;
  readonly homedir?: () => string;
  readonly opendir?: typeof fs.promises.opendir;
  readonly stat?: typeof fs.promises.stat;
}

export class TheaterFolderListError extends Error {
  readonly code: TheaterFolderListErrorCode;

  constructor(code: TheaterFolderListErrorCode) {
    super(code);
    this.name = "TheaterFolderListError";
    this.code = code;
  }
}

const DIRECTORY_ENTRY_CAP = 500;
const WINDOWS_DRIVE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

export async function listTheaterFolders(requestedPath: string | null | undefined, deps: TheaterFolderBrowserDeps = {}): Promise<ConsoleTheaterFolderListResponse> {
  const platform = deps.platform ?? process.platform;
  const stat = deps.stat ?? fs.promises.stat;
  const opendir = deps.opendir ?? fs.promises.opendir;
  const targetPath = normalizeListPath(requestedPath, platform, deps);
  const roots = await listRoots(platform, stat);
  const targetStat = await statDirectory(targetPath, stat);
  if (!targetStat.isDirectory()) throw new TheaterFolderListError("invalid_path");
  const entries: ConsoleTheaterFolderListEntry[] = [];
  const truncated = await collectDirectoryEntries(targetPath, opendir, stat, entries);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return {
    path: targetPath,
    parentPath: parentPath(targetPath, platform),
    roots,
    entries,
    ...(truncated ? { truncated: true } : {}),
  };
}

export function normalizeFolderBrowserPath(value: string, platform: NodeJS.Platform = process.platform): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new TheaterFolderListError("invalid_path");
  if (isWindowsAmbiguousPath(value, platform) || !path.isAbsolute(value)) throw new TheaterFolderListError("invalid_path");
  return path.resolve(value);
}

function normalizeListPath(requestedPath: string | null | undefined, platform: NodeJS.Platform, deps: TheaterFolderBrowserDeps): string {
  if (requestedPath === null || requestedPath === undefined) {
    const home = deps.homedir?.() ?? os.homedir();
    const start = home || deps.cwd?.() || process.cwd();
    return path.resolve(start);
  }
  return normalizeFolderBrowserPath(requestedPath, platform);
}

async function listRoots(platform: NodeJS.Platform, stat: typeof fs.promises.stat): Promise<readonly string[]> {
  if (platform !== "win32") return ["/"];
  const roots: string[] = [];
  await Promise.all(WINDOWS_DRIVE_LETTERS.map(async (letter) => {
    const root = `${letter}:\\`;
    try {
      if ((await stat(root)).isDirectory()) roots.push(root);
    } catch {
      // Missing or inaccessible drives are simply not advertised.
    }
  }));
  return roots.sort();
}

async function statDirectory(targetPath: string, stat: typeof fs.promises.stat): Promise<fs.Stats> {
  try {
    return await stat(targetPath);
  } catch (error) {
    throw mapFsError(error);
  }
}

async function collectDirectoryEntries(
  targetPath: string,
  opendir: typeof fs.promises.opendir,
  stat: typeof fs.promises.stat,
  entries: ConsoleTheaterFolderListEntry[],
): Promise<boolean> {
  const directory = await openDirectory(targetPath, opendir);
  try {
    let dirent = await directory.read();
    while (dirent !== null) {
      const entry = await toTheaterFolderEntry(targetPath, dirent, stat);
      if (entry !== null) {
        if (entries.length >= DIRECTORY_ENTRY_CAP) return true;
        entries.push(entry);
      }
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

async function toTheaterFolderEntry(targetPath: string, dirent: fs.Dirent, stat: typeof fs.promises.stat): Promise<ConsoleTheaterFolderListEntry | null> {
  if (!dirent.isDirectory() && !dirent.isSymbolicLink()) return null;
  const entryPath = path.join(targetPath, dirent.name);
  if (dirent.isDirectory()) return { name: dirent.name, path: entryPath, kind: "dir", accessible: true };
  const accessible = await statSymlinkDirectory(entryPath, stat);
  if (accessible === null) return null;
  return { name: dirent.name, path: entryPath, kind: "dir", accessible };
}

async function statSymlinkDirectory(entryPath: string, stat: typeof fs.promises.stat): Promise<boolean | null> {
  try {
    return (await stat(entryPath)).isDirectory() ? true : null;
  } catch {
    return false;
  }
}

function mapFsError(error: unknown): TheaterFolderListError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") return new TheaterFolderListError("forbidden");
  if (code === "ENOENT" || code === "ENOTDIR") return new TheaterFolderListError("not_found");
  return new TheaterFolderListError("invalid_path");
}

function parentPath(targetPath: string, platform: NodeJS.Platform): string | null {
  const parsed = path.parse(targetPath);
  const resolved = path.resolve(targetPath);
  if (resolved === path.resolve(parsed.root)) return null;
  const parent = path.dirname(resolved);
  if (platform === "win32" && parent === resolved) return null;
  return parent;
}

function isWindowsAmbiguousPath(value: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return false;
  return /^[a-zA-Z]:(?![\\/])/.test(value) || /^[\\/](?![\\/])/.test(value);
}

export async function listTheaterContents(
  theaterPath: string,
  relativePath: string,
  deps: Pick<TheaterFolderBrowserDeps, "opendir" | "stat"> = {},
): Promise<TheaterContentsListResult> {
  const opendir = deps.opendir ?? fs.promises.opendir;
  const stat = deps.stat ?? fs.promises.stat;
  const targetAbs = path.resolve(theaterPath, relativePath);
  const normalizedRoot = theaterPath.endsWith(path.sep) ? theaterPath : theaterPath + path.sep;
  if (targetAbs !== theaterPath && !targetAbs.startsWith(normalizedRoot)) {
    throw new TheaterFolderListError("forbidden");
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
    throw new TheaterFolderListError("forbidden");
  }

  const targetStat = await statDirectory(realTargetAbs, stat);
  if (!targetStat.isDirectory()) throw new TheaterFolderListError("invalid_path");
  const entries: TheaterContentsEntry[] = [];
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

async function collectContentsEntries(
  targetPath: string,
  theaterPath: string,
  opendir: typeof fs.promises.opendir,
  stat: typeof fs.promises.stat,
  entries: TheaterContentsEntry[],
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

async function toContentsEntry(
  targetPath: string,
  theaterPath: string,
  dirent: fs.Dirent,
  stat: typeof fs.promises.stat,
): Promise<TheaterContentsEntry | null> {
  if (dirent.name.startsWith(".")) return null;
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
