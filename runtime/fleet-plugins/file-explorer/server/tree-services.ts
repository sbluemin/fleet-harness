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
import { invalidateSearchCatalog, searchFilesWithRipgrep } from "./search-engine.js";
import type { FileSearchItem, FileSearchResult, FolderEntry, FolderListResult } from "./types.js";
import { watcherRegistry } from "./watcher.js";

// ═══ folder-browser ══════════════════════════════════════════════════════════

export type FolderBrowserErrorCode = "invalid_path" | "not_found" | "forbidden";

class FolderBrowserError extends Error {
  readonly code: FolderBrowserErrorCode;

  constructor(code: FolderBrowserErrorCode) {
    super(code);
    this.name = "FolderBrowserError";
    this.code = code;
  }
}

const DIRECTORY_ENTRY_CAP = 500;
/** 심링크 분류 동시성 — 직렬 realpath/stat가 큰 폴더 펼침을 막지 않게 한다. */
const CLASSIFY_CONCURRENCY = 16;

/** 버전 관리 날것 디렉터리 — 목록·필터·검색에서 항상 제외하고, 제외 사실은 hiddenVcsInternals로 알린다. */
const VCS_INTERNAL_NAMES: ReadonlySet<string> = new Set([".git", ".svn", ".hg"]);

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
  await attachEntryStats(entries, realTargetAbs, stat);
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
    // 이름+dirent 종류만 전량 수집한다. realpath/stat는 이름순 cap 뒤에만 돌린다.
    const cheap: fs.Dirent[] = [];
    for (let dirent = await directory.read(); dirent !== null; dirent = await directory.read()) {
      if (VCS_INTERNAL_NAMES.has(dirent.name)) hiddenVcs.push(dirent.name);
      else cheap.push(dirent);
    }
    cheap.sort((left, right) => left.name.localeCompare(right.name));
    const truncated = cheap.length > DIRECTORY_ENTRY_CAP;
    const kept = truncated ? cheap.slice(0, DIRECTORY_ENTRY_CAP) : cheap;

    for (let start = 0; start < kept.length; start += CLASSIFY_CONCURRENCY) {
      const batch = kept.slice(start, start + CLASSIFY_CONCURRENCY);
      const classified = await Promise.all(
        batch.map((item) => toContentsEntry(targetPath, theaterPath, item, stat)),
      );
      for (const entry of classified) {
        if (entry === null) continue;
        if ("vcsInternal" in entry) {
          hiddenVcs.push(entry.vcsInternal);
          continue;
        }
        entries.push(entry);
      }
    }
    return truncated;
  } catch (error) {
    throw mapFolderBrowserFsError(error);
  } finally {
    await directory.close();
  }
}

/**
 * 수집된 엔트리에 정렬용 메타(sizeBytes/mtimeMs)를 사후 일괄 부착한다.
 * 수집 루프의 빠른 경로(일반 dirent는 stat 없이 통과)를 건드리지 않기 위해 별도 패스로 둔다.
 * stat 실패(경합 삭제 등)는 해당 엔트리의 메타만 생략한다.
 */
async function attachEntryStats(
  entries: FolderEntry[],
  targetPath: string,
  stat: typeof fs.promises.stat,
): Promise<void> {
  for (let start = 0; start < entries.length; start += CLASSIFY_CONCURRENCY) {
    const batch = entries.slice(start, start + CLASSIFY_CONCURRENCY);
    await Promise.all(batch.map(async (entry, offset) => {
      try {
        const s = await stat(path.join(targetPath, entry.name));
        entries[start + offset] = {
          ...entry,
          ...(entry.kind === "file" ? { sizeBytes: s.size } : {}),
          mtimeMs: s.mtimeMs,
        };
      } catch {
        // 메타는 정렬 보조 신호다 — 실패해도 목록 자체를 막지 않는다.
      }
    }));
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

class GitStatusPathError extends Error {
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
const SEARCH_LIMIT_MAX = 200;

/** 재귀 검색 보행에서만 건너뛴다. files/list 트리 목록은 이 디렉터리를 그대로 보여 준다. */
const SEARCH_IGNORED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  ".pnpm",
  ".yarn",
  "bower_components",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "target",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".svelte-kit",
  ".angular",
  ".venv",
  "__pycache__",
  ".gradle",
  ".terraform",
]);

export interface TheaterFileSearchOutcome {
  readonly files: readonly FileSearchItem[];
  readonly totalMatches: number;
  readonly walkCapped?: true;
  readonly ignoredSkipped: boolean;
}

export interface SearchTheaterFilesOptions {
  readonly signal?: AbortSignal;
  /** 결과에 포함할 종류. 파일 열기용 팔레트는 파일만 받아야 디렉터리를 문서로 열려다 실패하지 않는다. */
  readonly kinds?: readonly ("file" | "dir")[];
  /** 숨김(점) 경로 포함 여부. 상한과 집계 "전에" 걸러야 표시 수와 안내 수가 어긋나지 않는다. */
  readonly includeHidden?: boolean;
  /** 무시 목록을 끄고 의존성·산출 폴더까지 순회한다(첫 순회가 0건일 때의 폴백 경로). */
  readonly includeIgnored?: boolean;
}

export async function searchTheaterFiles(
  theaterPath: string,
  query: string,
  limit: number,
  options: SearchTheaterFilesOptions = {},
): Promise<TheaterFileSearchOutcome> {
  const realRoot = await fsp.realpath(theaterPath);
  const tokens = tokenizeSearchQuery(query);
  const pending: Array<{ readonly absolutePath: string; readonly relativePath: string }> = [{ absolutePath: realRoot, relativePath: "" }];
  const visited = new Set<string>();
  const matches: FileSearchItem[] = [];
  let directoryCount = 0;
  let entryCount = 0;
  let walkCapped = false;
  let ignoredSkipped = false;
  const signal = options.signal;
  const honorIgnoreList = options.includeIgnored !== true;
  const allowedKinds = options.kinds;
  const includeHidden = options.includeHidden !== false;
  const accepts = (relativePath: string, kind: "file" | "dir"): boolean => {
    if (allowedKinds && !allowedKinds.includes(kind)) return false;
    if (!includeHidden && relativePath.split("/").some((segment) => segment.startsWith("."))) return false;
    return true;
  };

  if (tokens.length === 0) return { files: [], totalMatches: 0, ignoredSkipped: false };

  while (pending.length > 0) {
    if (signal?.aborted) {
      return { files: [], totalMatches: 0, ignoredSkipped };
    }
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
      if (signal?.aborted) {
        return { files: [], totalMatches: 0, ignoredSkipped };
      }
      if (entryCount >= SEARCH_ENTRY_CAP) { walkCapped = true; break; }
      // VCS 날것과, 숨김을 끈 질의의 숨김 항목은 예산을 쓰기 전에 뺀다.
      // 결과에서만 걸러내면 점 파일 25,000개가 항목 예산을 태워 보이는 파일에 닿지 못한다.
      if (VCS_INTERNAL_NAMES.has(entry.name)) continue;
      if (!includeHidden && entry.name.startsWith(".")) continue;
      entryCount += 1;
      const relativePath = directory.relativePath ? `${directory.relativePath}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory.absolutePath, entry.name);
      const ignoredName = honorIgnoreList && SEARCH_IGNORED_DIRECTORY_NAMES.has(entry.name);
      let kind: "dir" | "file" | null = entry.isDirectory() ? "dir" : entry.isFile() ? "file" : null;
      let realPath = absolutePath;
      if (entry.isSymbolicLink()) {
        if (ignoredName) {
          ignoredSkipped = true;
          if (accepts(relativePath, "dir") && pathMatchesSearchTokens(relativePath, tokens)) matches.push({ relativePath, kind: "dir" });
          continue;
        }
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
        if (accepts(relativePath, "dir") && pathMatchesSearchTokens(relativePath, tokens)) matches.push({ relativePath, kind: "dir" });
        if (ignoredName) {
          ignoredSkipped = true;
          continue;
        }
        // 숨김을 끈 질의에서는 숨김 디렉터리 자체를 순회에서 뺀다. 결과만 걸러내면
        // .fleet 같은 큰 점 디렉터리가 500폴더 예산을 다 써서, 보이는 파일이 다시 안 나온다.
        if (!includeHidden && entry.name.startsWith(".")) continue;
        if (!visited.has(realPath)) pending.push({ absolutePath: realPath, relativePath });
        continue;
      }
      if (kind !== "file") continue;
      if (accepts(relativePath, "file") && pathMatchesSearchTokens(relativePath, tokens)) matches.push({ relativePath, kind: "file" });
    }
    if (walkCapped) break;
  }

  if (signal?.aborted) {
    return { files: [], totalMatches: 0, ignoredSkipped };
  }

  const sorted = matches
    .sort((left, right) => compareFileSearchItem(left, right, query));
  return {
    files: sorted.slice(0, limit),
    totalMatches: sorted.length,
    ignoredSkipped,
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
    readonly kinds?: unknown;
    readonly includeHidden?: unknown;
    readonly scope?: unknown;
    readonly literal?: unknown;
  }>(req);
  if (
    !isPlainObject(body)
    || typeof body.theaterId !== "string"
    || typeof body.query !== "string"
    || body.query.trim() === ""
    || !Number.isInteger(body.limit)
    || (body.limit as number) < 1
    || (body.limit as number) > SEARCH_LIMIT_MAX
  ) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_request" });
    return;
  }
  const kinds = parseSearchKinds(body.kinds);
  if (kinds === "invalid") { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }
  if (body.scope !== undefined && body.scope !== "files" && body.scope !== "contents") {
    ctx.host.http.writeJson(res, 400, { error: "invalid_request" });
    return;
  }
  if (body.literal !== undefined && typeof body.literal !== "boolean") {
    ctx.host.http.writeJson(res, 400, { error: "invalid_request" });
    return;
  }
  const scope = body.scope === "contents" ? "contents" : "files";
  if (scope === "contents" && kinds?.includes("dir")) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_request" });
    return;
  }
  const includeHidden = body.includeHidden === true;
  const theaterPath = ctx.host.paths.resolveTheaterPath(body.theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }
  const abort = new AbortController();
  // 취소 신호는 응답 소켓에서 읽는다. IncomingMessage의 "close"는 요청 본문을 다 읽은 직후에도
  // 발생하므로(본문이 짧으면 항상), 그걸 취소로 쓰면 모든 검색이 응답 없이 끝난다.
  const onClose = () => { if (!res.writableEnded) abort.abort(); };
  if (typeof res.on === "function") res.on("close", onClose);
  const detach = () => { if (typeof res.off === "function") res.off("close", onClose); };
  try {
    if (abort.signal.aborted) return;
    let outcome: FileSearchResult;
    try {
      outcome = await searchFilesWithRipgrep(theaterPath, body.query, body.limit as number, {
        signal: abort.signal,
        includeHidden,
        scope,
        literal: body.literal !== false,
      });
    } catch {
      if (abort.signal.aborted) return;
      // 실행 파일이 없는 플랫폼도 파일명 검색은 유지한다. 내용 검색은 거짓 결과 대신 실패한다.
      if (scope === "contents") throw new Error("content_search_unavailable");
      let walker = await searchTheaterFiles(theaterPath, body.query, body.limit as number, {
        signal: abort.signal,
        ...(kinds ? { kinds } : {}),
        includeHidden,
      });
      if (walker.totalMatches === 0 && walker.ignoredSkipped && !walker.walkCapped) {
        const fallback = await searchTheaterFiles(theaterPath, body.query, body.limit as number, {
          signal: abort.signal,
          includeIgnored: true,
          ...(kinds ? { kinds } : {}),
          includeHidden,
        });
        if (fallback.totalMatches > 0) walker = { ...fallback, ignoredSkipped: false };
      }
      outcome = {
        ...walker,
        complete: walker.walkCapped !== true,
        engine: "walker",
        degraded: "walker",
      };
    }
    if (abort.signal.aborted) return;
    ctx.host.http.writeJson(res, 200, outcome);
  } catch (error) {
    if (abort.signal.aborted) return;
    const message = error instanceof Error ? error.message : "search_failed";
    ctx.host.http.writeJson(res, message === "content_search_unavailable" ? 503 : 500, { error: message });
  } finally {
    detach();
  }
}

/** 요청의 kinds를 검증한다 — 알 수 없는 값은 조용히 무시하지 않고 거절한다. */
function parseSearchKinds(raw: unknown): readonly ("file" | "dir")[] | null | "invalid" {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length === 0) return "invalid";
  const kinds: ("file" | "dir")[] = [];
  for (const value of raw) {
    if (value !== "file" && value !== "dir") return "invalid";
    if (!kinds.includes(value)) kinds.push(value);
  }
  return kinds;
}

function tokenizeSearchQuery(query: string): string[] {
  return query.trim().toLocaleLowerCase().split(/[\s/]+/).filter(Boolean);
}

function pathMatchesSearchTokens(relativePath: string, tokens: readonly string[]): boolean {
  const low = relativePath.toLocaleLowerCase();
  return tokens.every((token) => low.includes(token));
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
    // 감시 등록은 응답을 막지 않는다. Linux 첫 펼침의 중복 realpath/stat를 목록 지연에서 뺀다.
    void watcherRegistry.trackDirectory(rawTheaterId, theaterPath, relPath).catch(() => {});
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
    // 개행 포함 파일명이 SSE 필드 경계를 깨지 않도록 JSON으로 프레이밍한다.
    // 같은 신호로 path catalog도 무효화해 다음 질의가 디스크를 다시 읽는다.
    (relDir) => {
      invalidateSearchCatalog(theaterPath);
      sendEvent("change", JSON.stringify(relDir));
    },
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
