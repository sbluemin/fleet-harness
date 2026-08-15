import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import type http from "node:http";
import path from "node:path";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { ClipboardUnavailableError, copyPathToClipboard, PathActionError } from "./path-actions.js";
import { FileActionUnavailableError, revealPath, type FileRevealMode } from "./path-actions.js";
import { FileReadError, readFileForTheater } from "./file-reader.js";
import { ImageServeError, readImageForTheater, writeImageResponse } from "./image-server.js";
import type { FileSearchItem, FolderEntry, FolderListResult } from "./types.js";
import { watcherRegistry } from "./watcher.js";

// ═══ folder-browser ══════════════════════════════════════════════════════════

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

/** 버전 관리 날것 디렉터리 — 목록·필터·검색에서 항상 제외하고, 제외 사실은 hiddenVcsInternals로 알린다. */
export const VCS_INTERNAL_NAMES: ReadonlySet<string> = new Set([".git", ".svn", ".hg"]);

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
    throw mapFolderBrowserFsError(error);
  }
  const realNormalizedRoot = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (realTargetAbs !== realRoot && !realTargetAbs.startsWith(realNormalizedRoot)) {
    throw new FolderBrowserError("forbidden");
  }
  // 요청된 폴터 자체가 VCS 날것으로 실해석되면(리타기팅된 별칭 등) 수집을 거부한다.
  if (vcsSegmentOf(realRoot, realTargetAbs)) throw new FolderBrowserError("forbidden");

  const targetStat = await statDirectory(realTargetAbs, stat);
  if (!targetStat.isDirectory()) throw new FolderBrowserError("invalid_path");

  const entries: FolderEntry[] = [];
  const hiddenVcs: string[] = [];
  const truncated = await collectContentsEntries(realTargetAbs, realRoot, opendir, stat, entries, hiddenVcs);
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
    ...(truncated ? { truncated: true as const, cap: DIRECTORY_ENTRY_CAP } : {}),
    ...(hiddenVcs.length > 0 ? { hiddenVcsInternals: [...new Set(hiddenVcs)].sort() } : {}),
  };
}

async function statDirectory(targetPath: string, stat: typeof fs.promises.stat): Promise<fs.Stats> {
  try {
    return await stat(targetPath);
  } catch (error) {
    throw mapFolderBrowserFsError(error);
  }
}

async function collectContentsEntries(
  targetPath: string,
  theaterPath: string,
  opendir: typeof fs.promises.opendir,
  stat: typeof fs.promises.stat,
  entries: FolderEntry[],
  hiddenVcs: string[],
): Promise<boolean> {
  const directory = await openDirectory(targetPath, opendir);
  try {
    let dirent = await directory.read();
    while (dirent !== null) {
      // 분류(이름 + 심링크 실해석)가 cap 판정보다 먼저다 — 상한은 "표시 가능한" 항목만 센다.
      if (VCS_INTERNAL_NAMES.has(dirent.name)) {
        hiddenVcs.push(dirent.name);
        dirent = await directory.read();
        continue;
      }
      const entry = await toContentsEntry(targetPath, theaterPath, dirent, stat);
      if (entry === null) {
        dirent = await directory.read();
        continue;
      }
      if ("vcsInternal" in entry) {
        hiddenVcs.push(entry.vcsInternal);
        dirent = await directory.read();
        continue;
      }
      if (entries.length >= DIRECTORY_ENTRY_CAP) return true;
      entries.push(entry);
      dirent = await directory.read();
    }
    return false;
  } catch (error) {
    throw mapFolderBrowserFsError(error);
  } finally {
    await directory.close();
  }
}

async function openDirectory(targetPath: string, opendir: typeof fs.promises.opendir): Promise<fs.Dir> {
  try {
    return await opendir(targetPath, { bufferSize: DIRECTORY_ENTRY_CAP + 1 });
  } catch (error) {
    throw mapFolderBrowserFsError(error);
  }
}

/** 심링크 별칭이 VCS 날것으로 확인된 경우의 표식 — 목록에서 빼고 이름을 기록한다. */
interface VcsInternalMarker {
  readonly vcsInternal: string;
}

/** 실해석 경로가 Theater 루트 아래의 VCS 날것(.git 등) 안에 있으면 그 세그먼트 이름을 반환한다. */
function vcsSegmentOf(realRoot: string, realPath: string): string | null {
  const rel = path.relative(realRoot, realPath);
  if (!rel) return null;
  for (const segment of rel.split(path.sep)) {
    if (VCS_INTERNAL_NAMES.has(segment)) return segment;
  }
  return null;
}

async function toContentsEntry(
  targetPath: string,
  theaterPath: string,
  dirent: fs.Dirent,
  stat: typeof fs.promises.stat,
): Promise<FolderEntry | VcsInternalMarker | null> {
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
      // 이름 우회 별칭(metadata -> .git)도 실해석 경로의 세그먼트로 VCS 날것을 판별한다.
      const vcsSegment = vcsSegmentOf(theaterPath, realEntryPath);
      if (vcsSegment) return { vcsInternal: vcsSegment };
      const s = await stat(realEntryPath);
      if (s.isDirectory()) return { name: dirent.name, relativePath: rel, kind: "dir" };
      if (s.isFile()) return { name: dirent.name, relativePath: rel, kind: "file" };
    } catch {
      return null;
    }
  }
  return null;
}

function mapFolderBrowserFsError(error: unknown): FolderBrowserError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") return new FolderBrowserError("forbidden");
  if (code === "ENOENT" || code === "ENOTDIR") return new FolderBrowserError("not_found");
  return new FolderBrowserError("invalid_path");
}

// ═══ git-status ══════════════════════════════════════════════════════════════

export type GitFileStatus = "modified" | "untracked" | "deleted";

export interface GitStatusEntry {
  readonly path: string;
  readonly status: GitFileStatus;
}

export interface GitStatusResult {
  readonly ok: true;
  readonly gitAvailable: boolean;
  readonly statuses: readonly GitStatusEntry[];
  readonly truncated?: true;
  /** truncated일 때의 상한 값 */
  readonly cap?: number;
}

export type GitStatusPathErrorCode = "invalid_path" | "not_found" | "forbidden";

export class GitStatusPathError extends Error {
  readonly code: GitStatusPathErrorCode;

  constructor(code: GitStatusPathErrorCode) {
    super(code);
    this.name = "GitStatusPathError";
    this.code = code;
  }
}

interface ParsedGitStatusEntry {
  readonly gitPath: string;
  readonly status: GitFileStatus;
}

interface GitStatusDependencies {
  readonly realpath?: (target: string) => Promise<string>;
  readonly execGit?: (args: readonly string[], options: GitExecOptions) => Promise<string>;
  readonly environment?: NodeJS.ProcessEnv;
}

interface GitExecOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly killSignal: "SIGKILL";
  readonly maxBuffer: number;
  readonly timeout: number;
}

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const GIT_STATUS_CAP = 10_000;
const UNMERGED_STATUS_PAIRS = new Set(["UU", "UD", "DU", "AA", "AU", "UA", "DD"]);

export async function readTheaterGitStatus(
  theaterPath: string,
  deps: GitStatusDependencies = {},
): Promise<GitStatusResult> {
  const realpath = deps.realpath ?? ((target: string) => fsp.realpath(target));
  const execGit = deps.execGit ?? executeGit;
  let theaterRootAbs: string;
  try {
    theaterRootAbs = await realpath(path.resolve(theaterPath));
  } catch (error) {
    throw mapGitStatusFsError(error);
  }

  try {
    const options: GitExecOptions = {
      env: sanitizeGitEnvironment(deps.environment ?? process.env),
      killSignal: "SIGKILL",
      maxBuffer: GIT_MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS,
    };
    const gitArgs = (args: readonly string[]) => [
      "-c",
      "core.fsmonitor=false",
      "--no-optional-locks",
      "-C",
      theaterRootAbs,
      ...args,
    ];
    const [prefixOutput, statusOutput] = await Promise.all([
      execGit(gitArgs(["rev-parse", "--show-prefix"]), options),
      execGit(gitArgs(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]), options),
    ]);
    const prefix = stripTrailingLineBreak(prefixOutput);
    const statuses = scopeGitStatusesToTheater(parseGitStatusPorcelainV1Z(statusOutput), prefix);
    const truncated = statuses.length > GIT_STATUS_CAP;
    return {
      ok: true,
      gitAvailable: true,
      statuses: statuses.slice(0, GIT_STATUS_CAP),
      ...(truncated ? { truncated: true as const, cap: GIT_STATUS_CAP } : {}),
    };
  } catch {
    return { ok: true, gitAvailable: false, statuses: [] };
  }
}

export function parseGitStatusPorcelainV1Z(output: string): ParsedGitStatusEntry[] {
  const records = output.split("\0");
  const statuses: ParsedGitStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4 || record[2] !== " ") continue;

    const indexStatus = record[0] ?? " ";
    const worktreeStatus = record[1] ?? " ";
    const statusPair = `${indexStatus}${worktreeStatus}`;
    const gitPath = record.slice(3);
    const isRenameOrCopy = statusPair.includes("R") || statusPair.includes("C");
    const status = classifyGitStatus(statusPair);
    if (status && gitPath) statuses.push({ gitPath, status });

    // In porcelain v1 -z, rename/copy records are "new\0old\0".
    if (isRenameOrCopy && index + 1 < records.length) index += 1;
  }
  return statuses;
}

export function scopeGitStatusesToTheater(
  entries: readonly ParsedGitStatusEntry[],
  prefix: string,
  separator = path.sep,
): GitStatusEntry[] {
  const statuses: GitStatusEntry[] = [];
  for (const entry of entries) {
    if (prefix && !entry.gitPath.startsWith(prefix)) continue;
    const relativeGitPath = prefix ? entry.gitPath.slice(prefix.length) : entry.gitPath;
    const segments = relativeGitPath.split("/");
    if (
      relativeGitPath === ""
      || relativeGitPath.startsWith("/")
      || segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ) continue;
    const relativePath = segments.join(separator);
    if (path.isAbsolute(relativePath)) continue;
    statuses.push({ path: relativePath, status: entry.status });
  }
  return statuses;
}

function classifyGitStatus(statusPair: string): GitFileStatus | null {
  if (statusPair === "??") return "untracked";
  if (UNMERGED_STATUS_PAIRS.has(statusPair)) return "modified";
  if (statusPair.includes("D")) return "deleted";
  if ([...statusPair].some((status) => status === "A" || status === "M" || status === "R" || status === "C" || status === "T")) {
    return "modified";
  }
  return null;
}

function executeGit(args: readonly string[], options: GitExecOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      {
        encoding: "utf8",
        env: options.env,
        killSignal: options.killSignal,
        maxBuffer: options.maxBuffer,
        shell: false,
        timeout: options.timeout,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function sanitizeGitEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    // 저장소 라우팅을 바꾸는 GIT_* 상속은 전부 차단한다(allowlist 방식) —
    // GIT_COMMON_DIR 같은 변수가 새어나가면 status가 다른 저장소를 가리켜
    // 배지 전체가 숨겨지거나 잘못된 저장소를 읽는다. 필요한 값만 아래서 재주입.
    // askpass 프로그램 환경변수도 zero-click 실행 경로라 함께 차단한다.
    const normalizedKey = key.toUpperCase();
    if (normalizedKey.startsWith("GIT_") || normalizedKey === "LC_ALL" || normalizedKey === "SSH_ASKPASS" || normalizedKey === "SSH_ASKPASS_REQUIRE") continue;
    if (value !== undefined) sanitized[key] = value;
  }
  sanitized.GIT_OPTIONAL_LOCKS = "0";
  sanitized.GIT_TERMINAL_PROMPT = "0";
  // repo config으로 덮을 수 없는 default-deny transport allowlist — 알 수 없는
  // remote helper(`<vcs>::` URL, remote.<name>.vcs)의 zero-click 실행을 막는다.
  sanitized.GIT_ALLOW_PROTOCOL = "ssh:git:http:https:file";
  sanitized.LC_ALL = "C";
  return sanitized;
}

function stripTrailingLineBreak(output: string): string {
  if (!output.endsWith("\n")) return output;
  const withoutLineFeed = output.slice(0, -1);
  return withoutLineFeed.endsWith("\r") ? withoutLineFeed.slice(0, -1) : withoutLineFeed;
}

function mapGitStatusFsError(error: unknown): GitStatusPathError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") return new GitStatusPathError("forbidden");
  if (code === "ENOENT" || code === "ENOTDIR") return new GitStatusPathError("not_found");
  return new GitStatusPathError("invalid_path");
}

// ═══ search ══════════════════════════════════════════════════════════════════

const SEARCH_DIRECTORY_CAP = 500;
const SEARCH_ENTRY_CAP = 25_000;

export interface TheaterFileSearchOutcome {
  readonly files: readonly FileSearchItem[];
  readonly totalMatches: number;
  readonly walkCapped?: true;
}

export async function searchTheaterFiles(theaterPath: string, query: string, limit: number): Promise<TheaterFileSearchOutcome> {
  const realRoot = await fsp.realpath(theaterPath);
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const pending: Array<{ readonly absolutePath: string; readonly relativePath: string }> = [{ absolutePath: realRoot, relativePath: "" }];
  const visited = new Set<string>();
  const matches: FileSearchItem[] = [];
  let directoryCount = 0;
  let entryCount = 0;
  let walkCapped = false;

  while (pending.length > 0) {
    if (directoryCount >= SEARCH_DIRECTORY_CAP || entryCount >= SEARCH_ENTRY_CAP) {
      // 상한 도달은 조용히 끝내지 않고 호출자에게 알린다 — 클라이언트가 표식을 띄운다.
      walkCapped = true;
      break;
    }
    const directory = pending.shift();
    if (!directory || visited.has(directory.absolutePath)) continue;
    visited.add(directory.absolutePath);
    directoryCount += 1;

    let entries;
    try {
      entries = await fsp.readdir(directory.absolutePath, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (entryCount >= SEARCH_ENTRY_CAP) { walkCapped = true; break; }
      entryCount += 1;
      // VCS 날것은 검색 대상에서 항상 제외한다.
      if (VCS_INTERNAL_NAMES.has(entry.name)) continue;
      const relativePath = directory.relativePath ? `${directory.relativePath}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory.absolutePath, entry.name);
      let kind: "dir" | "file" | null = entry.isDirectory() ? "dir" : entry.isFile() ? "file" : null;
      let realPath = absolutePath;
      if (entry.isSymbolicLink()) {
        try {
          realPath = await fsp.realpath(absolutePath);
          if (!isContained(realRoot, realPath)) continue;
          // 별칭 심링크가 가리키는 VCS 날것도 검색 대상에서 제외한다.
          if (vcsSegmentOf(realRoot, realPath)) continue;
          const stat = await fsp.stat(realPath);
          kind = stat.isDirectory() ? "dir" : stat.isFile() ? "file" : null;
        } catch {
          continue;
        }
      }
      if (kind === "dir") {
        if (!visited.has(realPath)) pending.push({ absolutePath: realPath, relativePath });
        continue;
      }
      if (kind !== "file") continue;
      const low = relativePath.toLocaleLowerCase();
      if (tokens.every((token) => low.includes(token))) matches.push({ relativePath });
    }
    if (walkCapped) break;
  }

  const sorted = matches
    .sort((left, right) => compareFileSearchItem(left, right, query));
  return {
    files: sorted.slice(0, limit),
    totalMatches: sorted.length,
    ...(walkCapped ? { walkCapped: true as const } : {}),
  };
}

export async function handleFilesSearch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }
  const body = await ctx.host.http.readJsonBody<{
    readonly theaterId?: unknown;
    readonly query?: unknown;
    readonly limit?: unknown;
  }>(req);
  if (
    !isPlainObject(body)
    || typeof body.theaterId !== "string"
    || typeof body.query !== "string"
    || body.query.trim() === ""
    || !Number.isInteger(body.limit)
    || (body.limit as number) < 1
    || (body.limit as number) > 8
  ) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_request" });
    return;
  }
  const theaterPath = ctx.host.paths.resolveTheaterPath(body.theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }
  try {
    const outcome = await searchTheaterFiles(theaterPath, body.query, body.limit as number);
    ctx.host.http.writeJson(res, 200, {
      files: outcome.files,
      totalMatches: outcome.totalMatches,
      ...(outcome.walkCapped ? { walkCapped: true } : {}),
    });
  } catch {
    ctx.host.http.writeJson(res, 500, { error: "search_failed" });
  }
}

function compareFileSearchItem(left: FileSearchItem, right: FileSearchItem, query: string): number {
  const lowQuery = query.trim().toLocaleLowerCase();
  const leftName = left.relativePath.split("/").at(-1)?.toLocaleLowerCase() ?? "";
  const rightName = right.relativePath.split("/").at(-1)?.toLocaleLowerCase() ?? "";
  const leftRank = leftName === lowQuery ? 0 : leftName.startsWith(lowQuery) ? 1 : 2;
  const rightRank = rightName === lowQuery ? 0 : rightName.startsWith(lowQuery) ? 1 : 2;
  return leftRank - rightRank || left.relativePath.localeCompare(right.relativePath);
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// ═══ handlers ════════════════════════════════════════════════════════════════

interface ClipboardHandlerDependencies {
  readonly copyPath: typeof copyPathToClipboard;
}

interface RevealHandlerDependencies {
  readonly revealPath: typeof revealPath;
}

const DEFAULT_CLIPBOARD_DEPENDENCIES: ClipboardHandlerDependencies = { copyPath: copyPathToClipboard };
const DEFAULT_REVEAL_DEPENDENCIES: RevealHandlerDependencies = { revealPath };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readUrl(req: http.IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
}

export async function handleFilesList(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{ readonly theaterId?: unknown; readonly relativePath?: unknown }>(req);
  if (!isPlainObject(body)) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }

  const rawTheaterId = body.theaterId;
  if (typeof rawTheaterId !== "string") { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }

  const rawRel = body.relativePath;
  const relPath = rawRel === undefined || rawRel === null ? "" : typeof rawRel === "string" ? rawRel : null;
  if (relPath === null) { ctx.host.http.writeJson(res, 400, { error: "invalid_path" }); return; }

  const theaterPath = ctx.host.paths.resolveTheaterPath(rawTheaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  try {
    const result = await listTheaterContents(theaterPath, relPath);
    await watcherRegistry.trackDirectory(rawTheaterId, theaterPath, relPath);
    ctx.host.http.writeJson(res, 200, result);
  } catch (error) {
    if (error instanceof FolderBrowserError) {
      const httpStatus = error.code === "forbidden" ? 403 : error.code === "not_found" ? 404 : 400;
      ctx.host.http.writeJson(res, httpStatus, { error: error.code });
      return;
    }
    throw error;
  }
}

export async function handleFilesGitStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{ readonly theaterId?: unknown }>(req);
  if (!isPlainObject(body) || typeof body.theaterId !== "string") {
    ctx.host.http.writeJson(res, 400, { error: "invalid_request" });
    return;
  }

  const theaterPath = ctx.host.paths.resolveTheaterPath(body.theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  try {
    ctx.host.http.writeJson(res, 200, await readTheaterGitStatus(theaterPath));
  } catch (error) {
    if (error instanceof GitStatusPathError) {
      const httpStatus = error.code === "forbidden" ? 403 : error.code === "not_found" ? 404 : 400;
      ctx.host.http.writeJson(res, httpStatus, { error: error.code });
      return;
    }
    throw error;
  }
}

export async function handleFilesRead(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{ readonly theaterId?: unknown; readonly relativePath?: unknown }>(req);
  if (!isPlainObject(body) || typeof body.relativePath !== "string") { ctx.host.http.writeJson(res, 400, { error: "invalid_path" }); return; }

  const theaterId = body.theaterId;
  if (typeof theaterId !== "string") { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }

  const theaterPath = ctx.host.paths.resolveTheaterPath(theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  try {
    const result = await readFileForTheater(theaterPath, body.relativePath);
    ctx.host.http.writeJson(res, 200, result);
  } catch (error) {
    if (error instanceof FileReadError) {
      const httpStatus = error.code === "path_outside_theater" || error.code === "forbidden" ? 403 : error.code === "binary_file" ? 422 : 404;
      ctx.host.http.writeJson(res, httpStatus, { error: error.code });
      return;
    }
    throw error;
  }
}

export async function handleFilesImage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "GET") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const url = readUrl(req);
  const theaterId = url.searchParams.get("theaterId");
  const relPath = url.searchParams.get("path");

  if (!theaterId) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }
  if (!relPath) { ctx.host.http.writeJson(res, 400, { error: "invalid_path" }); return; }

  const theaterPath = ctx.host.paths.resolveTheaterPath(theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  try {
    const result = await readImageForTheater(theaterPath, relPath);
    writeImageResponse(res, result);
  } catch (error) {
    if (error instanceof ImageServeError) {
      const httpStatus = error.code === "path_outside_theater" || error.code === "mime_not_allowed" || error.code === "forbidden" ? 403 : error.code === "size_exceeded" ? 413 : 404;
      ctx.host.http.writeJson(res, httpStatus, { error: error.code });
      return;
    }
    throw error;
  }
}

export async function handleFilesClipboard(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  dependencies: ClipboardHandlerDependencies = DEFAULT_CLIPBOARD_DEPENDENCIES,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{ readonly theaterId?: unknown; readonly relativePath?: unknown }>(req);
  if (!isPlainObject(body) || typeof body.theaterId !== "string" || typeof body.relativePath !== "string") {
    ctx.host.http.writeJson(res, 400, { error: "invalid_request" });
    return;
  }

  const theaterPath = ctx.host.paths.resolveTheaterPath(body.theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  try {
    await dependencies.copyPath(theaterPath, body.relativePath);
    writeNoContent(res);
  } catch (error) {
    if (error instanceof PathActionError) {
      writePathActionError(res, ctx, error);
      return;
    }
    if (error instanceof ClipboardUnavailableError) {
      ctx.host.http.writeJson(res, 501, { error: "clipboard_unavailable" });
      return;
    }
    ctx.host.http.writeJson(res, 500, { error: "clipboard_failed" });
  }
}

export async function handleFilesReveal(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  dependencies: RevealHandlerDependencies = DEFAULT_REVEAL_DEPENDENCIES,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{
    readonly theaterId?: unknown;
    readonly relativePath?: unknown;
    readonly mode?: unknown;
  }>(req);
  if (
    !isPlainObject(body)
    || typeof body.theaterId !== "string"
    || typeof body.relativePath !== "string"
    || !isFileRevealMode(body.mode)
  ) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_request" });
    return;
  }

  const theaterPath = ctx.host.paths.resolveTheaterPath(body.theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  try {
    await dependencies.revealPath(theaterPath, body.relativePath, body.mode);
    writeNoContent(res);
  } catch (error) {
    if (error instanceof PathActionError) {
      writePathActionError(res, ctx, error);
      return;
    }
    if (error instanceof FileActionUnavailableError) {
      ctx.host.http.writeJson(res, 501, { error: "action_unavailable" });
      return;
    }
    ctx.host.http.writeJson(res, 500, { error: "action_failed" });
  }
}

export function handleFilesWatch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): void {
  if (req.method !== "GET") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  // EventSource는 same-origin GET — origin 헤더 미첨부여도 isTerminalAuthorized 통과
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const url = readUrl(req);
  const theaterId = url.searchParams.get("theaterId");
  if (!theaterId) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }

  const theaterPath = ctx.host.paths.resolveTheaterPath(theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  // SSE 헤더 — 응답을 스트림으로 유지
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  function sendEvent(name: string, data: string): void {
    try {
      res.write(`event: ${name}\ndata: ${data}\n\n`);
    } catch {
      // 연결 종료 후 쓰기 시도 무시
    }
  }

  const unsubscribe = watcherRegistry.subscribe(
    theaterId,
    theaterPath,
    // 개행 포함 파일명이 SSE 필드 경계를 깨지 않도록 JSON으로 프레이밍한다
    (relDir) => sendEvent("change", JSON.stringify(relDir)),
    (state) => sendEvent("state", state),
  );

  req.on("close", () => {
    unsubscribe();
    try { res.end(); } catch { /* 이미 종료된 경우 무시 */ }
  });
}

function isFileRevealMode(value: unknown): value is FileRevealMode {
  return value === "reveal" || value === "open";
}

function writeNoContent(res: http.ServerResponse): void {
  res.statusCode = 204;
  res.end();
}

function writePathActionError(
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  error: PathActionError,
): void {
  const status = error.code === "not_found" ? 404 : 403;
  ctx.host.http.writeJson(res, status, { error: error.code });
}
