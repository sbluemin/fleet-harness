import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ConsoleTheaterFolderListEntry, ConsoleTheaterFolderListResponse } from "../console-contract-types.js";

export function workspaceHash(canonicalCwd: string): string {
  return crypto.createHash("sha256").update(canonicalCwd).digest("hex").slice(0, 12);
}

export async function canonicalizeTheaterPath(cwd: string): Promise<string> {
  return canonicalizeTheaterPathSync(cwd);
}

export function canonicalizeTheaterPathSync(cwd: string): string {
  const resolved = path.resolve(cwd);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function theaterLabel(cwd: string): string {
  return path.basename(cwd) || cwd;
}

export interface TheaterRootResolution {
  readonly realRoot: string;
}

class TheaterRootError extends Error {
  readonly code: "invalid_path" | "not_found" | "forbidden";

  constructor(code: TheaterRootError["code"]) {
    super(code);
    this.code = code;
  }
}

export async function resolveTheaterRoot(theaterRoot: string): Promise<TheaterRootResolution> {
  const nominalRoot = path.resolve(theaterRoot);
  let realRoot: string;
  try {
    realRoot = await fs.promises.realpath(nominalRoot);
  } catch (error) {
    throw mapFsError(error);
  }
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(realRoot);
  } catch (error) {
    throw mapFsError(error);
  }
  if (!stat.isDirectory()) throw new TheaterRootError("invalid_path");
  return { realRoot };
}

function mapFsError(error: unknown): TheaterRootError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return new TheaterRootError("not_found");
  if (code === "EACCES" || code === "EPERM") return new TheaterRootError("forbidden");
  return new TheaterRootError("invalid_path");
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
    throw mapFolderListFsError(error);
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
    throw mapFolderListFsError(error);
  } finally {
    await directory.close();
  }
}

async function openDirectory(targetPath: string, opendir: typeof fs.promises.opendir): Promise<fs.Dir> {
  try {
    return await opendir(targetPath);
  } catch (error) {
    throw mapFolderListFsError(error);
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

function mapFolderListFsError(error: unknown): TheaterFolderListError {
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

export interface FolderGrantStoreDeps {
  readonly randomId?: () => string;
  readonly statSync?: typeof fs.statSync;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export interface FolderGrantStore {
  issue(cwd: string): string;
  consume(folderGrantId: string): string | null;
}

interface StoredGrant {
  readonly cwd: string;
  readonly expiresAt: number;
}

const GRANT_ID_BYTES = 24;
// folderGrant는 폴더 선택 직후의 짧은 세션 생성 흐름에서만 쓰인다. 유출된 grant가 오래
// 살아남지 못하도록 terminal ticket과 같은 단명 TTL을 적용하고, issue/consume마다 prune한다.
const DEFAULT_GRANT_TTL_MS = 60_000;

export function createFolderGrantStore(deps: FolderGrantStoreDeps = {}): FolderGrantStore {
  const randomId = deps.randomId ?? (() => crypto.randomBytes(GRANT_ID_BYTES).toString("base64url"));
  const statSync = deps.statSync ?? fs.statSync;
  const ttlMs = deps.ttlMs ?? DEFAULT_GRANT_TTL_MS;
  const now = deps.now ?? Date.now;
  const grants = new Map<string, StoredGrant>();

  function issue(cwd: string): string {
    prune();
    const normalized = validateAbsoluteDirectory(cwd, statSync);
    const folderGrantId = randomId();
    grants.set(folderGrantId, { cwd: normalized, expiresAt: now() + ttlMs });
    return folderGrantId;
  }

  function consume(folderGrantId: string): string | null {
    prune();
    const stored = grants.get(folderGrantId);
    grants.delete(folderGrantId);
    if (!stored || stored.expiresAt <= now()) return null;
    return stored.cwd;
  }

  function prune(): void {
    const current = now();
    for (const [id, stored] of grants) {
      if (stored.expiresAt <= current) grants.delete(id);
    }
  }

  return { issue, consume };
}

export function validateAbsoluteDirectory(cwd: string, statSync: typeof fs.statSync = fs.statSync): string {
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.includes("\0")) throw new Error("invalid_folder");
  if (isWindowsAmbiguousGrantPath(cwd) || !path.isAbsolute(cwd)) throw new Error("invalid_folder");
  const normalized = path.resolve(cwd);
  if (!statSync(normalized).isDirectory()) throw new Error("invalid_folder");
  return normalized;
}

function isWindowsAmbiguousGrantPath(value: string): boolean {
  if (process.platform !== "win32") return false;
  return /^[a-zA-Z]:(?![\\/])/.test(value) || /^[\\/](?![\\/])/.test(value);
}

export interface TheaterRegistration {
  readonly id: string;
  readonly path: string;
  readonly realpath: string;
  readonly label: string;
  readonly registeredAt: string;
  readonly lastOpenedAt: string;
  readonly order?: number;
}

export class TheaterRegistry {
  readonly #items = new Map<string, TheaterRegistration>();
  #mruId: string | null = null;

  async register(cwd: string): Promise<TheaterRegistration> {
    const resolved = path.resolve(cwd);
    const real = await canonicalizeTheaterPath(resolved);
    const id = workspaceHash(real);
    const now = new Date().toISOString();
    const existing = this.#items.get(id);
    if (existing && existing.realpath !== real) {
      throw new Error("theater_id_collision");
    }
    const item: TheaterRegistration = {
      id,
      path: resolved,
      realpath: real,
      label: theaterLabel(resolved),
      registeredAt: existing?.registeredAt ?? now,
      lastOpenedAt: now,
      order: existing?.order,
    };
    this.#items.set(id, item);
    this.#mruId = id;
    return item;
  }

  load(items: readonly TheaterRegistration[]): void {
    this.restore(items);
  }

  restore(items: readonly TheaterRegistration[]): void {
    const restored = new Map<string, TheaterRegistration>();
    let mruId: string | null = null;
    for (const item of items) {
      const existing = restored.get(item.id);
      if (existing && existing.realpath !== item.realpath) {
        throw new Error("theater_id_collision");
      }
      restored.set(item.id, item);
      if (!mruId || item.lastOpenedAt.localeCompare(restored.get(mruId)?.lastOpenedAt ?? "") > 0) {
        mruId = item.id;
      }
    }
    this.#items.clear();
    for (const [id, item] of restored) this.#items.set(id, item);
    this.#mruId = mruId;
  }

  get(id: string): TheaterRegistration | null {
    return this.#items.get(id) ?? null;
  }

  getMru(): TheaterRegistration | null {
    return this.#mruId ? this.get(this.#mruId) : null;
  }

  list(): readonly TheaterRegistration[] {
    return [...this.#items.values()].sort((left, right) => {
      if (left.order !== undefined && right.order !== undefined) return left.order - right.order;
      if (left.order === undefined && right.order === undefined) return right.lastOpenedAt.localeCompare(left.lastOpenedAt);
      return left.order === undefined ? -1 : 1;
    });
  }

  setOrder(id: string, order: number): TheaterRegistration | null {
    const existing = this.#items.get(id);
    if (!existing) return null;
    const updated: TheaterRegistration = { ...existing, order };
    this.#items.set(id, updated);
    return updated;
  }

  remove(id: string): boolean {
    const removed = this.#items.delete(id);
    if (this.#mruId === id) {
      this.#mruId = [...this.#items.values()]
        .sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt))[0]?.id ?? null;
    }
    return removed;
  }
}
