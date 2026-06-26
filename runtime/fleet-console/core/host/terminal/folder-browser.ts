import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ConsoleTheaterFolderListEntry, ConsoleTheaterFolderListResponse } from "../api-types.js";

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
